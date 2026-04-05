import { mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { getChromePath } from "chrome-launcher";
import type { ConnectionMode } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { log, warn } from "../lib/logger.js";
import type { SessionRecord, WhatsAppProvider } from "./types.js";

type RuntimeListener = {
  off?: () => void;
};

type WaMessage = {
  body?: string;
  caption?: string;
  from?: string;
  fromMe?: boolean;
  isGroupMsg?: boolean;
};

type WaClient = {
  forceRefocus?: () => Promise<boolean>;
  getHostNumber?: () => Promise<string>;
  getMe?: () => Promise<{ me?: { user?: string } } | null>;
  getState?: () => Promise<string>;
  isConnected?: () => Promise<boolean>;
  kill?: (reason?: string) => Promise<boolean>;
  logout?: (preserveSessionData?: boolean) => Promise<boolean>;
  onMessage?: (handler: (message: WaMessage) => Promise<void> | void) => Promise<unknown>;
  onStateChanged?: (handler: (state: string) => void) => Promise<unknown>;
  sendText?: (to: string, message: string) => Promise<unknown>;
};

type WaEventEmitter = {
  on: (
    event: string,
    listener: (data: unknown, sessionId?: string, namespace?: string) => void,
    options?: unknown,
  ) => RuntimeListener | void;
};

type OpenWaRuntimeModule = {
  create: (config: Record<string, unknown>) => Promise<WaClient>;
  ev: WaEventEmitter;
};

type LegacyRuntimeModule = {
  confirmAppointmentsTick: (
    sendFn: (to: string, message: string) => Promise<unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<number>;
  handleMessage: (client: WaClient, chatId: string, text: string, tools?: Record<string, unknown>) => Promise<void>;
  remind24hTick: (
    sendFn: (to: string, message: string) => Promise<unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<number>;
  reviewFollowupsTick: (
    sendFn: (to: string, message: string) => Promise<unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<number>;
  resetState: (chatId: string) => void;
  safeSend: (client: WaClient, chatId: string, text: string, opts?: Record<string, unknown>) => Promise<string>;
  warmOllama: () => Promise<void>;
};

type RuntimeSession = {
  client?: WaClient;
  confirmIntervalId?: NodeJS.Timeout;
  createPromise?: Promise<WaClient | null>;
  generation: number;
  messageListenerAttached: boolean;
  mode: ConnectionMode | null;
  qrListener?: RuntimeListener;
  record: SessionRecord;
  reviewIntervalId?: NodeJS.Timeout;
  reviewTimeoutId?: NodeJS.Timeout;
  reminderIntervalId?: NodeJS.Timeout;
  sessionId: string;
  stateListenerAttached: boolean;
  terminalQrCleanup?: () => void;
  userId: string;
  wildcardListener?: RuntimeListener;
};

const runtimes = new Map<string, RuntimeSession>();
const require = createRequire(import.meta.url);
const TerminalQrCode = require("qrcode-terminal/vendor/QRCode");
const TerminalQrErrorLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const terminalQrConsumers = new Map<string, (payload: { dataUrl: string | null; ascii: string }) => void>();
const terminalQrAnsiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const terminalQrFullBlock = "\u2588";
const terminalQrUpperHalfBlock = "\u2580";
const terminalQrLowerHalfBlock = "\u2584";
const terminalQrVerticalBorder = "\u2502";
const terminalQrTopLeftBorder = "\u250c";
const terminalQrTopRightBorder = "\u2510";
const terminalQrBottomLeftBorder = "\u2514";
const terminalQrBottomRightBorder = "\u2518";
const terminalQrCellPattern = new RegExp(
  `[${terminalQrUpperHalfBlock}${terminalQrLowerHalfBlock}${terminalQrFullBlock}]`,
  "u",
);

let openWaModulePromise: Promise<OpenWaRuntimeModule> | null = null;
let legacyRuntimePromise: Promise<LegacyRuntimeModule> | null = null;
let legacyWarmupPromise: Promise<void> | null = null;
let detectedChromePath: string | null | undefined;
let terminalQrObserverInstalled = false;
let terminalQrActiveSessionId: string | null = null;
let terminalQrCapturedLines: string[] = [];
let terminalQrStdoutBuffer = "";
let terminalQrStderrBuffer = "";

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

function resolveUserDir(userId: string): string {
  return path.join(env.sessionDir, sanitizeSegment(userId));
}

function resolveSessionDataDir(userId: string): string {
  return path.join(resolveUserDir(userId), "open-wa");
}

function buildSessionId(userId: string): string {
  return `session-${sanitizeSegment(userId)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function resolveChromeExecutablePath(): string | null {
  if (env.chromePath) {
    return env.chromePath;
  }

  if (detectedChromePath !== undefined) {
    return detectedChromePath;
  }

  try {
    const chromePath = getChromePath()?.trim();
    detectedChromePath = chromePath || null;
    if (detectedChromePath) {
      log(`Chrome rilevato automaticamente: ${detectedChromePath}`);
    }
  } catch (error) {
    detectedChromePath = null;
    warn("rilevamento automatico di Chrome fallito", error);
  }

  return detectedChromePath;
}

function normalizePhoneNumber(input: string | null | undefined): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits ? digits : null;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function buildQrMatrixFromRaw(value: string): boolean[][] | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  try {
    const qr = new TerminalQrCode(-1, TerminalQrErrorLevel.L);
    qr.addData(raw);
    qr.make();

    const moduleCount = Number(qr.getModuleCount?.() ?? 0);
    const matrix: boolean[][] = [];

    for (let row = 0; row < moduleCount; row += 1) {
      const matrixRow: boolean[] = [];
      for (let col = 0; col < moduleCount; col += 1) {
        matrixRow.push(Boolean(qr.isDark(row, col)));
      }
      matrix.push(matrixRow);
    }

    return matrix;
  } catch (error) {
    warn("ricostruzione matrice QR dal dato grezzo fallita", error);
    return null;
  }
}

function renderQrDataUrlFromMatrix(matrix: boolean[][]): string | null {
  if (matrix.length === 0 || matrix[0]?.length === 0) {
    return null;
  }

  try {
    const padding = 4;
    const pixelSize = 8;
    const rows = matrix.length;
    const columns = matrix[0]!.length;
    const canvasWidth = (columns + padding * 2) * pixelSize;
    const canvasHeight = (rows + padding * 2) * pixelSize;
    const cells: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        if (!matrix[row]?.[col]) {
          continue;
        }

        const x = (col + padding) * pixelSize;
        const y = (row + padding) * pixelSize;
        cells.push(`<rect x="${x}" y="${y}" width="${pixelSize}" height="${pixelSize}" />`);
      }
    }

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasWidth} ${canvasHeight}" width="${canvasWidth}" height="${canvasHeight}" shape-rendering="crispEdges">`,
      `<rect width="${canvasWidth}" height="${canvasHeight}" fill="#ffffff" />`,
      `<g fill="#111111">`,
      cells.join(""),
      "</g>",
      "</svg>",
    ].join("");

    return svgToDataUrl(svg);
  } catch (error) {
    warn("ricostruzione QR dal dato grezzo fallita", error);
    return null;
  }
}

function renderQrDataUrlFromRaw(value: string): string | null {
  const matrix = buildQrMatrixFromRaw(value);
  if (!matrix) {
    return null;
  }

  return renderQrDataUrlFromMatrix(matrix);
}

function encodeTerminalQrCell(top: boolean, bottom: boolean): string {
  if (top && bottom) {
    return terminalQrFullBlock;
  }

  if (top) {
    return terminalQrUpperHalfBlock;
  }

  if (bottom) {
    return terminalQrLowerHalfBlock;
  }

  return " ";
}

function renderTerminalQrAsciiFromMatrix(matrix: boolean[][]): string | null {
  const trimmed = trimTerminalQrMatrix(matrix);
  if (trimmed.length === 0 || trimmed[0]?.length === 0) {
    return null;
  }

  const quietZone = 2;
  const columns = trimmed[0]!.length + quietZone * 2;
  const paddedRows: boolean[][] = [];

  for (let index = 0; index < quietZone; index += 1) {
    paddedRows.push(Array.from({ length: columns }, () => false));
  }

  for (const row of trimmed) {
    paddedRows.push([
      ...Array.from({ length: quietZone }, () => false),
      ...row,
      ...Array.from({ length: quietZone }, () => false),
    ]);
  }

  for (let index = 0; index < quietZone; index += 1) {
    paddedRows.push(Array.from({ length: columns }, () => false));
  }

  if (paddedRows.length % 2 !== 0) {
    paddedRows.push(Array.from({ length: columns }, () => false));
  }

  const contentLines: string[] = [];

  for (let row = 0; row < paddedRows.length; row += 2) {
    const topRow = paddedRows[row]!;
    const bottomRow = paddedRows[row + 1]!;
    let content = "";

    for (let col = 0; col < columns; col += 1) {
      content += encodeTerminalQrCell(Boolean(topRow[col]), Boolean(bottomRow[col]));
    }

    contentLines.push(`${terminalQrVerticalBorder}${content}${terminalQrVerticalBorder}`);
  }

  const width = contentLines[0]?.length ?? 0;
  if (!width) {
    return null;
  }

  const topBorder = `${terminalQrTopLeftBorder}${"─".repeat(Math.max(0, width - 2))}${terminalQrTopRightBorder}`;
  const bottomBorder = `${terminalQrBottomLeftBorder}${"─".repeat(Math.max(0, width - 2))}${terminalQrBottomRightBorder}`;
  return [topBorder, ...contentLines, bottomBorder].join("\n");
}

function renderTerminalQrAsciiFromRaw(value: string): string | null {
  const matrix = buildQrMatrixFromRaw(value);
  if (!matrix) {
    return null;
  }

  return renderTerminalQrAsciiFromMatrix(matrix);
}

function stripTerminalAnsi(value: string): string {
  return value.replace(terminalQrAnsiPattern, "").replace(/\r/g, "");
}

function isTerminalQrCell(value: string): boolean {
  return terminalQrCellPattern.test(value);
}

function matchTerminalQrStartLine(value: string): string | null {
  const escapedTopLeft = terminalQrTopLeftBorder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedTopRight = terminalQrTopRightBorder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`^${escapedTopLeft}.*\\b(session-[A-Za-z0-9_-]+)\\b.*${escapedTopRight}$`, "u"));
  return match?.[1] ?? null;
}

function isTerminalQrEndLine(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(terminalQrBottomLeftBorder) && trimmed.endsWith(terminalQrBottomRightBorder);
}

function tryRenderQrDataUrlFromTerminalBlock(lines: string[]): string | null {
  const borderlessLines = lines.map((line) => {
    const cleaned = stripTerminalAnsi(line);
    const characters = [...cleaned];
    if (characters[0] === terminalQrVerticalBorder && characters[characters.length - 1] === terminalQrVerticalBorder) {
      return characters.slice(1, -1).join("");
    }

    return cleaned;
  });

  let firstQrRow = -1;
  let lastQrRow = -1;

  for (let index = 0; index < borderlessLines.length; index += 1) {
    if (isTerminalQrCell(borderlessLines[index]!)) {
      firstQrRow = index;
      break;
    }
  }

  for (let index = borderlessLines.length - 1; index >= 0; index -= 1) {
    if (isTerminalQrCell(borderlessLines[index]!)) {
      lastQrRow = index;
      break;
    }
  }

  if (firstQrRow === -1 || lastQrRow === -1 || firstQrRow > lastQrRow) {
    return null;
  }

  const relevantLines = borderlessLines.slice(firstQrRow, lastQrRow + 1).map((line) => [...line]);
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = -1;

  for (const line of relevantLines) {
    for (let index = 0; index < line.length; index += 1) {
      if (!isTerminalQrCell(line[index]!)) {
        continue;
      }

      minColumn = Math.min(minColumn, index);
      maxColumn = Math.max(maxColumn, index);
    }
  }

  if (!Number.isFinite(minColumn) || maxColumn < minColumn) {
    return null;
  }

  const matrix: boolean[][] = [];

  for (const line of relevantLines) {
    const topRow: boolean[] = [];
    const bottomRow: boolean[] = [];

    for (let index = minColumn; index <= maxColumn; index += 1) {
      const [topCell, bottomCell] = decodeTerminalQrCell(line[index] ?? " ");
      topRow.push(topCell);
      bottomRow.push(bottomCell);
    }

    matrix.push(topRow, bottomRow);
  }

  return renderQrDataUrlFromMatrix(trimTerminalQrMatrix(matrix));
}

function decodeTerminalQrCell(value: string): [boolean, boolean] {
  if (value === terminalQrFullBlock) {
    return [true, true];
  }

  if (value === terminalQrUpperHalfBlock) {
    return [true, false];
  }

  if (value === terminalQrLowerHalfBlock) {
    return [false, true];
  }

  switch (value) {
    case "█":
      return [true, true];
    case "▀":
      return [true, false];
    case "▄":
      return [false, true];
    default:
      return [false, false];
  }
}

function trimTerminalQrMatrix(matrix: boolean[][]): boolean[][] {
  let top = 0;
  let bottom = matrix.length - 1;

  while (top <= bottom && matrix[top]!.every((cell) => !cell)) {
    top += 1;
  }

  while (bottom >= top && matrix[bottom]!.every((cell) => !cell)) {
    bottom -= 1;
  }

  if (top > bottom) {
    return [];
  }

  let left = 0;
  let right = matrix[0]!.length - 1;

  while (left <= right && matrix.every((row) => !row[left])) {
    left += 1;
  }

  while (right >= left && matrix.every((row) => !row[right])) {
    right -= 1;
  }

  if (left > right) {
    return [];
  }

  return matrix.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
}

function buildTerminalQrAsciiBlock(lines: string[]): string {
  return lines.map((line) => stripTerminalAnsi(line).trimEnd()).join("\n").trim();
}

function renderQrDataUrlFromTerminalBlock(lines: string[]): string | null {
  const robustDataUrl = tryRenderQrDataUrlFromTerminalBlock(lines);
  if (robustDataUrl) {
    return robustDataUrl;
  }

  const borderlessLines = lines.map((line) => {
    const cleaned = stripTerminalAnsi(line);
    const characters = [...cleaned];
    if (characters[0] === "│" && characters[characters.length - 1] === "│") {
      return characters.slice(1, -1).join("");
    }

    return cleaned;
  });

  let firstQrRow = -1;
  let lastQrRow = -1;

  for (let index = 0; index < borderlessLines.length; index += 1) {
    if (/[▀▄█]/u.test(borderlessLines[index]!)) {
      firstQrRow = index;
      break;
    }
  }

  for (let index = borderlessLines.length - 1; index >= 0; index -= 1) {
    if (/[▀▄█]/u.test(borderlessLines[index]!)) {
      lastQrRow = index;
      break;
    }
  }

  if (firstQrRow === -1 || lastQrRow === -1 || firstQrRow > lastQrRow) {
    return null;
  }

  const relevantLines = borderlessLines.slice(firstQrRow, lastQrRow + 1).map((line) => [...line]);
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = -1;

  for (const line of relevantLines) {
    for (let index = 0; index < line.length; index += 1) {
      if (!/[▀▄█]/u.test(line[index]!)) {
        continue;
      }

      minColumn = Math.min(minColumn, index);
      maxColumn = Math.max(maxColumn, index);
    }
  }

  if (!Number.isFinite(minColumn) || maxColumn < minColumn) {
    return null;
  }

  const matrix: boolean[][] = [];

  for (const line of relevantLines) {
    const topRow: boolean[] = [];
    const bottomRow: boolean[] = [];

    for (let index = minColumn; index <= maxColumn; index += 1) {
      const [topCell, bottomCell] = decodeTerminalQrCell(line[index] ?? " ");
      topRow.push(topCell);
      bottomRow.push(bottomCell);
    }

    matrix.push(topRow, bottomRow);
  }

  return renderQrDataUrlFromMatrix(trimTerminalQrMatrix(matrix));
}

function applyTerminalQrData(runtime: RuntimeSession, dataUrl: string | null, qrCodeAscii: string | null = null) {
  runtime.record = withUpdatedRecord(runtime.record, {
    status: "waiting_qr",
    qrCodeDataUrl: dataUrl,
    qrCodeAscii,
    pairingCode: null,
    lastError: null,
    connectedAt: null,
  });
}

function processTerminalQrLine(line: string) {
  const cleaned = stripTerminalAnsi(line);
  if (!cleaned) {
    return;
  }

  const matchedSessionId = matchTerminalQrStartLine(cleaned);
  if (matchedSessionId) {
    terminalQrActiveSessionId = matchedSessionId;
    terminalQrCapturedLines = [cleaned];
    return;
  }

  const startMatch = cleaned.match(/^┌.*\b(session-[A-Za-z0-9_-]+)\b.*┐$/u);
  if (startMatch) {
    terminalQrActiveSessionId = startMatch[1]!;
    terminalQrCapturedLines = [cleaned];
    return;
  }

  if (!terminalQrActiveSessionId) {
    return;
  }

  terminalQrCapturedLines.push(cleaned);
  if (isTerminalQrEndLine(cleaned)) {
    const consumer = terminalQrConsumers.get(terminalQrActiveSessionId);
    const ascii = buildTerminalQrAsciiBlock(terminalQrCapturedLines);
    const dataUrl = renderQrDataUrlFromTerminalBlock(terminalQrCapturedLines);
    if (consumer) {
      consumer({ dataUrl, ascii });
    }

    terminalQrActiveSessionId = null;
    terminalQrCapturedLines = [];
    return;
  }
  if (!cleaned.trim().startsWith("└") || !cleaned.trim().endsWith("┘")) {
    return;
  }

  const consumer = terminalQrConsumers.get(terminalQrActiveSessionId);
  const ascii = buildTerminalQrAsciiBlock(terminalQrCapturedLines);
  const dataUrl = renderQrDataUrlFromTerminalBlock(terminalQrCapturedLines);
  if (consumer) {
    consumer({ dataUrl, ascii });
  }

  terminalQrActiveSessionId = null;
  terminalQrCapturedLines = [];
}

function installTerminalQrObserver() {
  if (terminalQrObserverInstalled) {
    return;
  }

  const interceptStream = (
    stream: NodeJS.WriteStream,
    getBuffer: () => string,
    setBuffer: (value: string) => void,
  ) => {
    const target = stream as NodeJS.WriteStream & { write: (...args: unknown[]) => boolean };
    const originalWrite = target.write.bind(target);

    target.write = (...args: unknown[]) => {
      const [chunk, encoding] = args;
      const normalizedEncoding =
        typeof encoding === "string" && Buffer.isEncoding(encoding)
          ? (encoding as BufferEncoding)
          : undefined;
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString(normalizedEncoding)
        : typeof chunk === "string"
          ? chunk
          : String(chunk ?? "");

      if (text) {
        let buffer = getBuffer() + text;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        setBuffer(buffer);
        for (const line of lines) {
          processTerminalQrLine(line);
        }
      }

      return originalWrite(...args);
    };
  };

  interceptStream(process.stdout, () => terminalQrStdoutBuffer, (value) => {
    terminalQrStdoutBuffer = value;
  });
  interceptStream(process.stderr, () => terminalQrStderrBuffer, (value) => {
    terminalQrStderrBuffer = value;
  });
  terminalQrObserverInstalled = true;
}

function ensureTerminalQrFallback(runtime: RuntimeSession) {
  if (runtime.terminalQrCleanup) {
    return;
  }

  installTerminalQrObserver();
  const consumer = (payload: { dataUrl: string | null; ascii: string }) => {
    applyTerminalQrData(runtime, payload.dataUrl, payload.ascii);
    log(`QR ASCII catturato dal terminale per ${runtime.userId}`, {
      sessionId: runtime.sessionId,
      hasImage: Boolean(payload.dataUrl),
      asciiLength: payload.ascii.length,
    });
  };

  terminalQrConsumers.set(runtime.sessionId, consumer);
  runtime.terminalQrCleanup = () => {
    const currentConsumer = terminalQrConsumers.get(runtime.sessionId);
    if (currentConsumer === consumer) {
      terminalQrConsumers.delete(runtime.sessionId);
    }
    runtime.terminalQrCleanup = undefined;
  };
}

function withUpdatedRecord(record: SessionRecord, patch: Partial<SessionRecord>): SessionRecord {
  return {
    ...record,
    ...patch,
    updatedAt: nowIso(),
  };
}

function mergeRuntimeRecord(
  liveRecord: SessionRecord,
  incomingRecord: SessionRecord,
  mode: ConnectionMode | null = null,
): SessionRecord {
  return {
    ...incomingRecord,
    ...liveRecord,
    connectionMode: mode ?? liveRecord.connectionMode ?? incomingRecord.connectionMode,
    qrCodeDataUrl: liveRecord.qrCodeDataUrl ?? incomingRecord.qrCodeDataUrl ?? null,
    qrCodeAscii: liveRecord.qrCodeAscii ?? incomingRecord.qrCodeAscii ?? null,
    pairingCode: liveRecord.pairingCode ?? incomingRecord.pairingCode ?? null,
    phoneNumber: liveRecord.phoneNumber ?? incomingRecord.phoneNumber ?? null,
    lastError: liveRecord.lastError ?? incomingRecord.lastError ?? null,
    connectedAt: liveRecord.connectedAt ?? incomingRecord.connectedAt ?? null,
    sessionPersisted: liveRecord.sessionPersisted || incomingRecord.sessionPersisted,
    autoConnectAt: liveRecord.autoConnectAt ?? incomingRecord.autoConnectAt ?? null,
  };
}

async function hasPersistedArtifacts(userId: string): Promise<boolean> {
  try {
    const entries = await readdir(resolveSessionDataDir(userId), { withFileTypes: true });
    return entries.some((entry) => entry.name !== ".DS_Store");
  } catch {
    return false;
  }
}

function getOrCreateRuntime(record: SessionRecord, mode: ConnectionMode | null): RuntimeSession {
  const existing = runtimes.get(record.userId);
  if (existing) {
    existing.record = mergeRuntimeRecord(existing.record, record, mode);
    if (mode) {
      existing.mode = mode;
    }
    return existing;
  }

  const runtime: RuntimeSession = {
    generation: 0,
    messageListenerAttached: false,
    mode,
    record,
    sessionId: buildSessionId(record.userId),
    stateListenerAttached: false,
    userId: record.userId,
  };

  runtimes.set(record.userId, runtime);
  return runtime;
}

async function loadOpenWaModule(): Promise<OpenWaRuntimeModule> {
  if (!openWaModulePromise) {
    openWaModulePromise = import("@open-wa/wa-automate").then((module): OpenWaRuntimeModule => {
      const create = module.create ?? module.default?.create ?? module.default;
      if (typeof create !== "function") {
        throw new Error("create() di @open-wa/wa-automate non disponibile.");
      }

      if (!module.ev || typeof module.ev.on !== "function") {
        throw new Error("event emitter di @open-wa/wa-automate non disponibile.");
      }

      return {
        create: create as (config: Record<string, unknown>) => Promise<WaClient>,
        ev: module.ev as WaEventEmitter,
      };
    });
  }

  return openWaModulePromise!;
}

async function loadLegacyRuntime(): Promise<LegacyRuntimeModule> {
  if (!legacyRuntimePromise) {
    legacyRuntimePromise = import(new URL("../../../../util.js", import.meta.url).href) as Promise<LegacyRuntimeModule>;
  }

  return legacyRuntimePromise;
}

async function warmLegacyRuntime(): Promise<void> {
  if (!legacyWarmupPromise) {
    legacyWarmupPromise = (async () => {
      const legacy = await loadLegacyRuntime();
      await legacy.warmOllama();
    })();
  }

  await legacyWarmupPromise;
}

function clearRuntimeTimers(runtime: RuntimeSession) {
  if (runtime.reviewTimeoutId) {
    clearTimeout(runtime.reviewTimeoutId);
    runtime.reviewTimeoutId = undefined;
  }

  if (runtime.reviewIntervalId) {
    clearInterval(runtime.reviewIntervalId);
    runtime.reviewIntervalId = undefined;
  }

  if (runtime.reminderIntervalId) {
    clearInterval(runtime.reminderIntervalId);
    runtime.reminderIntervalId = undefined;
  }

  if (runtime.confirmIntervalId) {
    clearInterval(runtime.confirmIntervalId);
    runtime.confirmIntervalId = undefined;
  }
}

function detachRuntimeListeners(runtime: RuntimeSession) {
  runtime.qrListener?.off?.();
  runtime.wildcardListener?.off?.();
  runtime.qrListener = undefined;
  runtime.wildcardListener = undefined;
  runtime.messageListenerAttached = false;
  runtime.stateListenerAttached = false;
}

async function stopRuntimeClient(runtime: RuntimeSession) {
  const client = runtime.client;
  runtime.client = undefined;

  if (!client) {
    return;
  }

  try {
    await client.logout?.(false);
  } catch (error) {
    warn("logout open-wa fallito", error);
  }

  try {
    await client.kill?.("manual_disconnect");
  } catch (error) {
    warn("kill open-wa fallito", error);
  }
}

async function disposeRuntime(runtime: RuntimeSession, removeFromCache = false) {
  runtime.generation += 1;
  runtime.createPromise = undefined;
  detachRuntimeListeners(runtime);
  clearRuntimeTimers(runtime);
  await stopRuntimeClient(runtime);

  if (removeFromCache) {
    runtime.terminalQrCleanup?.();
  }

  if (removeFromCache) {
    runtimes.delete(runtime.userId);
  }
}

function mapState(runtime: RuntimeSession, state: string): Partial<SessionRecord> {
  const normalized = String(state || "").toUpperCase();

  switch (normalized) {
    case "CONNECTED":
      return {
        status: "connected",
        qrCodeDataUrl: null,
        qrCodeAscii: null,
        pairingCode: null,
        lastError: null,
        connectedAt: runtime.record.connectedAt ?? nowIso(),
      };
    case "OPENING":
    case "PAIRING":
    case "SYNCING":
      return {
        status: "connecting",
        lastError: null,
      };
    case "UNPAIRED":
    case "UNPAIRED_IDLE":
      return {
        status: runtime.mode === "pairing" ? "waiting_pairing" : "waiting_qr",
        connectedAt: null,
      };
    case "DISCONNECTED":
      return {
        status: "disconnected",
        connectedAt: null,
      };
    case "CONFLICT":
    case "UNLAUNCHED":
      return {
        status: "connecting",
        lastError: null,
      };
    case "PROXYBLOCK":
    case "TOS_BLOCK":
    case "SMB_TOS_BLOCK":
    case "DEPRECATED_VERSION":
    case "TIMEOUT":
      return {
        status: "error",
        lastError: `Stato WhatsApp non valido: ${normalized}`,
      };
    default:
      return {};
  }
}

async function snapshotClient(runtime: RuntimeSession): Promise<Partial<SessionRecord>> {
  const client = runtime.client;
  if (!client) {
    return {};
  }

  const patch: Partial<SessionRecord> = {};

  try {
    const state = await client.getState?.();
    if (state) {
      Object.assign(patch, mapState(runtime, state));
    }
  } catch (error) {
    warn("lettura stato open-wa fallita", error);
  }

  try {
    const isConnected = await client.isConnected?.();
    if (isConnected) {
      patch.status = "connected";
      patch.connectedAt = runtime.record.connectedAt ?? nowIso();
      patch.lastError = null;
      patch.qrCodeDataUrl = null;
      patch.qrCodeAscii = null;
      patch.pairingCode = null;
    }
  } catch (error) {
    warn("verifica connessione open-wa fallita", error);
  }

  try {
    const hostNumber = normalizePhoneNumber(await client.getHostNumber?.());
    if (hostNumber) {
      patch.phoneNumber = hostNumber;
    }
  } catch {
    try {
      const me = await client.getMe?.();
      const phone = normalizePhoneNumber(me?.me?.user);
      if (phone) {
        patch.phoneNumber = phone;
      }
    } catch (error) {
      warn("lettura numero host open-wa fallita", error);
    }
  }

  patch.sessionPersisted = await hasPersistedArtifacts(runtime.userId);
  return patch;
}

function handleQrPayload(runtime: RuntimeSession, payload: unknown) {
  const value = String(payload ?? "").trim();
  if (!value) {
    return;
  }

  if (value.startsWith("data:image/")) {
    applyTerminalQrData(runtime, value, runtime.record.qrCodeAscii ?? null);
    return;
  }

  if (value.length === 9) {
    runtime.record = withUpdatedRecord(runtime.record, {
      status: "waiting_pairing",
      pairingCode: value,
      qrCodeDataUrl: null,
      qrCodeAscii: null,
      lastError: null,
      connectedAt: null,
    });
    return;
  }

  const rebuiltQr = renderQrDataUrlFromRaw(value);
  const qrAscii = renderTerminalQrAsciiFromRaw(value);
  if (rebuiltQr || qrAscii) {
    applyTerminalQrData(runtime, rebuiltQr, qrAscii);
    return;
  }

  runtime.record = withUpdatedRecord(runtime.record, {
    status: "waiting_pairing",
    pairingCode: value,
    qrCodeDataUrl: null,
    qrCodeAscii: null,
    lastError: null,
    connectedAt: null,
  });
}

function attachEmitterListeners(runtime: RuntimeSession, eventEmitter: WaEventEmitter) {
  runtime.qrListener?.off?.();
  runtime.wildcardListener?.off?.();

  runtime.qrListener =
    eventEmitter.on(
      `qr.${runtime.sessionId}`,
      (data) => {
        handleQrPayload(runtime, data);
      },
      { objectify: true } as { objectify: true },
    ) ?? undefined;

  runtime.wildcardListener =
    eventEmitter.on(
      `**.${runtime.sessionId}`,
      (data, _sessionId, namespace) => {
        if (namespace === "qr") {
          return;
        }

        if (namespace === "qrData") {
          handleQrPayload(runtime, data);
          return;
        }

        const text = String(data ?? "");
        if (text.includes("Authenticated")) {
          runtime.record = withUpdatedRecord(runtime.record, {
            status: "connecting",
            lastError: null,
          });
        }

        if (text.includes("ready for account")) {
          runtime.record = withUpdatedRecord(runtime.record, {
            status: "connected",
            qrCodeDataUrl: null,
            qrCodeAscii: null,
            pairingCode: null,
            connectedAt: runtime.record.connectedAt ?? nowIso(),
            lastError: null,
          });
        }
      },
      { objectify: true } as { objectify: true },
    ) ?? undefined;
}

async function attachLegacyAutomation(runtime: RuntimeSession) {
  const client = runtime.client;
  if (!client) {
    return;
  }

  if (!runtime.stateListenerAttached) {
    await client.onStateChanged?.((state) => {
      runtime.record = withUpdatedRecord(runtime.record, mapState(runtime, state));
      if (state === "CONFLICT" || state === "UNLAUNCHED" || state === "UNPAIRED") {
        void client.forceRefocus?.().catch(() => undefined);
      }
    });
    runtime.stateListenerAttached = true;
  }

  if (!runtime.messageListenerAttached) {
    const legacy = await loadLegacyRuntime();
    await client.onMessage?.(async (message) => {
      if (!message || message.isGroupMsg || message.fromMe) {
        return;
      }

      const chatId = message.from;
      const text = String(message.body ?? message.caption ?? "").trim();

      if (!chatId || !text) {
        return;
      }

      if (/^\s*(annulla|reset|stop|ricomincia)\s*$/i.test(text)) {
        legacy.resetState(chatId);
        await legacy.safeSend(client, chatId, "Ho annullato tutto, aspetto i tuoi ordini!");
        return;
      }

      await legacy.handleMessage(client, chatId, text);
    });
    runtime.messageListenerAttached = true;
  }

  if (!runtime.reviewIntervalId && !runtime.reviewTimeoutId) {
    const legacy = await loadLegacyRuntime();
    const sendReview = (to: string, message: string) => legacy.safeSend(client, to, message, { noFooter: true });
    const runReviewTick = () =>
      legacy.reviewFollowupsTick(sendReview, {
        lookbackDays: 3,
        minAfterEndMinutes: 15,
        batchLimit: 20,
      });

    const now = new Date();
    const minutes = now.getMinutes();
    const targetMinute = minutes < 30 ? 30 : 60;
    const initialDelay = Math.max(0, (targetMinute - minutes) * 60 * 1000 - now.getSeconds() * 1000);

    runtime.reviewTimeoutId = setTimeout(() => {
      void runReviewTick().catch((error) => warn("reviewFollowupsTick iniziale fallito", error));
      runtime.reviewIntervalId = setInterval(() => {
        void runReviewTick().catch((error) => warn("reviewFollowupsTick periodico fallito", error));
      }, 30 * 60 * 1000);
    }, initialDelay);
  }

  if (!runtime.reminderIntervalId) {
    const legacy = await loadLegacyRuntime();
    runtime.reminderIntervalId = setInterval(() => {
      void legacy
        .remind24hTick(
          (to, message) => client.sendText?.(to, message) ?? Promise.resolve(false),
          { graceMinutes: 10, batchLimit: 200 },
        )
        .catch((error) => warn("remind24hTick fallito", error));
    }, 60_000);
  }

  if (!runtime.confirmIntervalId) {
    const legacy = await loadLegacyRuntime();
    const sendConfirmation = (to: string, message: string) => legacy.safeSend(client, to, message, { noFooter: true });

    void legacy.confirmAppointmentsTick(sendConfirmation, {
      aheadMinutes: Number(process.env.CONFIRM_LEAD_MINUTES ?? 180),
      batchLimit: 50,
    }).catch((error) => warn("confirmAppointmentsTick iniziale fallito", error));

    runtime.confirmIntervalId = setInterval(() => {
      void legacy
        .confirmAppointmentsTick(sendConfirmation, {
          aheadMinutes: Number(process.env.CONFIRM_LEAD_MINUTES ?? 180),
          batchLimit: 50,
        })
        .catch((error) => warn("confirmAppointmentsTick periodico fallito", error));
    }, 15 * 60 * 1000);
  }
}

async function startRuntime(runtime: RuntimeSession, record: SessionRecord, mode: ConnectionMode): Promise<SessionRecord> {
  const phoneNumber = normalizePhoneNumber(record.phoneNumber);
  if (mode === "pairing" && !phoneNumber) {
    runtime.record = withUpdatedRecord(record, {
      status: "error",
      connectionMode: mode,
      lastError: "Inserisci prima il numero telefono nelle impostazioni per usare il pairing code.",
      qrCodeDataUrl: null,
      qrCodeAscii: null,
      pairingCode: null,
      sessionPersisted: await hasPersistedArtifacts(record.userId),
      connectedAt: null,
    });
    return runtime.record;
  }

  const generation = runtime.generation + 1;
  runtime.generation = generation;
  runtime.mode = mode;
  ensureTerminalQrFallback(runtime);
  runtime.record = withUpdatedRecord(record, {
    status: mode === "pairing" ? "waiting_pairing" : "waiting_qr",
    connectionMode: mode,
    phoneNumber,
    qrCodeDataUrl: null,
    qrCodeAscii: null,
    pairingCode: null,
    lastError: null,
    sessionPersisted: record.sessionPersisted,
    connectedAt: null,
  });

  const chromePath = resolveChromeExecutablePath();
  let launchPromise: Promise<WaClient | null>;
  launchPromise = (async () => {
      await mkdir(resolveSessionDataDir(record.userId), { recursive: true });
      runtime.record = withUpdatedRecord(runtime.record, {
        sessionPersisted: await hasPersistedArtifacts(record.userId),
      });

      const { create, ev } = await loadOpenWaModule();
      attachEmitterListeners(runtime, ev);

      const config: Record<string, unknown> = {
        authTimeout: env.authTimeoutMs,
        autoRefresh: true,
        cacheEnabled: false,
        headless: env.headless,
        killClientOnLogout: false,
        logConsole: false,
        multiDevice: true,
        popup: false,
        qrLogSkip: env.qrLogSkip,
        qrTimeout: env.qrTimeoutMs,
        sessionDataPath: resolveSessionDataDir(record.userId),
        sessionId: runtime.sessionId,
        useChrome: true,
        waitForRipeSession: true,
      };

      if (chromePath) {
        config.executablePath = chromePath;
      }

      if (process.platform === "linux") {
        config.chromiumArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
      }

      if (mode === "pairing" && phoneNumber) {
        config.linkCode = phoneNumber;
      }

      const client = await create(config);
      if (runtime.generation !== generation) {
        try {
          await client.kill?.("stale_generation");
        } catch {
          // no-op
        }
        return null;
      }

      runtime.client = client;
      await warmLegacyRuntime();
      await attachLegacyAutomation(runtime);

      const snapshot = await snapshotClient(runtime);
      runtime.record = withUpdatedRecord(runtime.record, {
        ...snapshot,
        status: snapshot.status ?? "connected",
        qrCodeDataUrl: null,
        qrCodeAscii: null,
        pairingCode: null,
        lastError: null,
        connectedAt: snapshot.connectedAt ?? runtime.record.connectedAt ?? nowIso(),
        sessionPersisted: await hasPersistedArtifacts(runtime.userId),
      });

      log(`Sessione WhatsApp pronta per ${runtime.userId}`, {
        phoneNumber: runtime.record.phoneNumber,
      });
      return client;
    })()
    .catch(async (error) => {
      if (runtime.generation === generation) {
        runtime.record = withUpdatedRecord(runtime.record, {
          status: "error",
          lastError: toErrorMessage(error),
          sessionPersisted: await hasPersistedArtifacts(runtime.userId),
        });
      }
      warn("Avvio open-wa fallito", error);
      return null;
    })
    .finally(() => {
      if (runtime.createPromise === launchPromise) {
        runtime.createPromise = undefined;
      }
    });

  runtime.createPromise = launchPromise;
  void runtime.createPromise.catch(() => undefined);
  return runtime.record;
}

async function refreshRuntime(runtime: RuntimeSession): Promise<SessionRecord> {
  if (!runtime.client) {
    runtime.record = withUpdatedRecord(runtime.record, {
      sessionPersisted: await hasPersistedArtifacts(runtime.userId),
    });
    return runtime.record;
  }

  const snapshot = await snapshotClient(runtime);
  runtime.record = withUpdatedRecord(runtime.record, {
    ...snapshot,
    sessionPersisted: await hasPersistedArtifacts(runtime.userId),
  });
  return runtime.record;
}

export class OpenWaLegacyProvider implements WhatsAppProvider {
  async initialize(record: SessionRecord, mode: ConnectionMode): Promise<SessionRecord> {
    const runtime = getOrCreateRuntime(record, mode);

    if (runtime.client) {
      return refreshRuntime(runtime);
    }

    if (runtime.createPromise && runtime.mode === mode) {
      return runtime.record;
    }

    if (runtime.createPromise && runtime.mode !== mode) {
      await disposeRuntime(runtime);
    }

    return startRuntime(runtime, record, mode);
  }

  async getStatus(record: SessionRecord): Promise<SessionRecord> {
    const runtime = runtimes.get(record.userId);
    if (runtime) {
      runtime.record = mergeRuntimeRecord(runtime.record, record);
      return refreshRuntime(runtime);
    }

    const sessionPersisted = await hasPersistedArtifacts(record.userId);
    return withUpdatedRecord(record, {
      sessionPersisted,
      status: "disconnected",
      qrCodeDataUrl: null,
      qrCodeAscii: null,
      pairingCode: null,
      connectedAt: null,
      lastError: null,
    });
  }

  async disconnect(record: SessionRecord): Promise<SessionRecord> {
    const runtime = runtimes.get(record.userId);
    if (runtime) {
      await disposeRuntime(runtime, true);
    }

    return withUpdatedRecord(record, {
      status: "disconnected",
      qrCodeDataUrl: null,
      qrCodeAscii: null,
      pairingCode: null,
      lastError: null,
      sessionPersisted: false,
      connectedAt: null,
    });
  }
}
