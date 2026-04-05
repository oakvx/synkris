import { mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

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
  userId: string;
  wildcardListener?: RuntimeListener;
};

const runtimes = new Map<string, RuntimeSession>();
const require = createRequire(import.meta.url);
const TerminalQrCode = require("qrcode-terminal/vendor/QRCode");
const TerminalQrErrorLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

let openWaModulePromise: Promise<OpenWaRuntimeModule> | null = null;
let legacyRuntimePromise: Promise<LegacyRuntimeModule> | null = null;
let legacyWarmupPromise: Promise<void> | null = null;

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

function normalizePhoneNumber(input: string | null | undefined): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits ? digits : null;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function renderQrDataUrlFromRaw(value: string): string | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  try {
    const qr = new TerminalQrCode(-1, TerminalQrErrorLevel.L);
    qr.addData(raw);
    qr.make();

    const moduleCount = Number(qr.getModuleCount?.() ?? 0);
    const padding = 4;
    const pixelSize = 8;
    const canvasSize = (moduleCount + padding * 2) * pixelSize;
    const cells: string[] = [];

    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        if (!qr.isDark(row, col)) {
          continue;
        }

        const x = (col + padding) * pixelSize;
        const y = (row + padding) * pixelSize;
        cells.push(`<rect x="${x}" y="${y}" width="${pixelSize}" height="${pixelSize}" />`);
      }
    }

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasSize} ${canvasSize}" width="${canvasSize}" height="${canvasSize}" shape-rendering="crispEdges">`,
      `<rect width="${canvasSize}" height="${canvasSize}" fill="#ffffff" />`,
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

function withUpdatedRecord(record: SessionRecord, patch: Partial<SessionRecord>): SessionRecord {
  return {
    ...record,
    ...patch,
    updatedAt: nowIso(),
  };
}

async function hasPersistedArtifacts(userId: string): Promise<boolean> {
  try {
    const entries = await readdir(resolveUserDir(userId), { withFileTypes: true });
    return entries.some((entry) => entry.name !== "session.json");
  } catch {
    return false;
  }
}

function getOrCreateRuntime(record: SessionRecord, mode: ConnectionMode | null): RuntimeSession {
  const existing = runtimes.get(record.userId);
  if (existing) {
    existing.record = {
      ...existing.record,
      ...record,
      connectionMode: mode ?? existing.record.connectionMode,
    };
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
    runtime.record = withUpdatedRecord(runtime.record, {
      status: "waiting_qr",
      qrCodeDataUrl: value,
      pairingCode: null,
      lastError: null,
      connectedAt: null,
    });
    return;
  }

  if (value.length === 9) {
    runtime.record = withUpdatedRecord(runtime.record, {
      status: "waiting_pairing",
      pairingCode: value,
      qrCodeDataUrl: null,
      lastError: null,
      connectedAt: null,
    });
    return;
  }

  const rebuiltQr = renderQrDataUrlFromRaw(value);
  if (rebuiltQr) {
    runtime.record = withUpdatedRecord(runtime.record, {
      status: "waiting_qr",
      qrCodeDataUrl: rebuiltQr,
      pairingCode: null,
      lastError: null,
      connectedAt: null,
    });
    return;
  }

  runtime.record = withUpdatedRecord(runtime.record, {
    status: "waiting_pairing",
    pairingCode: value,
    qrCodeDataUrl: null,
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
      pairingCode: null,
      sessionPersisted: await hasPersistedArtifacts(record.userId),
      connectedAt: null,
    });
    return runtime.record;
  }

  await mkdir(resolveSessionDataDir(record.userId), { recursive: true });

  const generation = runtime.generation + 1;
  runtime.generation = generation;
  runtime.mode = mode;
  runtime.record = withUpdatedRecord(record, {
    status: mode === "pairing" ? "waiting_pairing" : "waiting_qr",
    connectionMode: mode,
    phoneNumber,
    qrCodeDataUrl: null,
    pairingCode: null,
    lastError: null,
    sessionPersisted: await hasPersistedArtifacts(record.userId),
    connectedAt: null,
  });

  const { create, ev } = await loadOpenWaModule();
  attachEmitterListeners(runtime, ev);

  const chromiumArgs = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  const config: Record<string, unknown> = {
    authTimeout: env.authTimeoutMs,
    autoRefresh: true,
    cacheEnabled: false,
    chromiumArgs,
    executablePath: env.chromePath ?? undefined,
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

  if (mode === "pairing" && phoneNumber) {
    config.linkCode = phoneNumber;
  }

  runtime.createPromise = create(config)
    .then(async (client) => {
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
        pairingCode: null,
        lastError: null,
        connectedAt: snapshot.connectedAt ?? runtime.record.connectedAt ?? nowIso(),
        sessionPersisted: await hasPersistedArtifacts(runtime.userId),
      });

      log(`Sessione WhatsApp pronta per ${runtime.userId}`, {
        phoneNumber: runtime.record.phoneNumber,
      });
      return client;
    })
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
    });

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
      runtime.record = {
        ...runtime.record,
        ...record,
        connectionMode: runtime.record.connectionMode ?? record.connectionMode,
      };
      return refreshRuntime(runtime);
    }

    const sessionPersisted = await hasPersistedArtifacts(record.userId);
    if (sessionPersisted) {
      const started = getOrCreateRuntime(
        withUpdatedRecord(record, {
          sessionPersisted: true,
          status: record.status === "connected" ? "connected" : "connecting",
        }),
        record.connectionMode ?? "qr",
      );
      return startRuntime(started, started.record, started.mode ?? "qr");
    }

    return withUpdatedRecord(record, {
      sessionPersisted: false,
      status: record.status === "connected" ? "connected" : "disconnected",
      qrCodeDataUrl: null,
      pairingCode: null,
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
      pairingCode: null,
      lastError: null,
      sessionPersisted: false,
      connectedAt: null,
    });
  }
}
