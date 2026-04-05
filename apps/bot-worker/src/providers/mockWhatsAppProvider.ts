import { createHash } from "node:crypto";

import type { ConnectionMode } from "@whatsapp-ai/shared";

import type { SessionRecord, WhatsAppProvider } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function buildMockQrCode(userId: string, instanceId: string): string {
  const fingerprint = createHash("sha256").update(`${userId}:${instanceId}`).digest("hex").slice(0, 12);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
      <rect width="320" height="320" fill="#f7f3ea" rx="24" />
      <rect x="24" y="24" width="272" height="272" fill="#ffffff" rx="18" stroke="#17313e" stroke-width="8" />
      <rect x="52" y="52" width="72" height="72" fill="#17313e" rx="12" />
      <rect x="196" y="52" width="72" height="72" fill="#17313e" rx="12" />
      <rect x="52" y="196" width="72" height="72" fill="#17313e" rx="12" />
      <path d="M172 160h20v20h-20zm24 0h20v20h-20zm24 0h20v20h-20zm-24 24h20v20h-20zm24 24h20v20h-20zm-48 24h20v20h-20zm24 24h20v20h-20z" fill="#17313e" />
      <text x="160" y="292" text-anchor="middle" font-family="monospace" font-size="16" fill="#4d5f68">mock:${fingerprint}</text>
    </svg>
  `.trim();
  return svgToDataUrl(svg);
}

function buildMockPairingCode(userId: string): string {
  const raw = createHash("sha256").update(userId).digest("hex").slice(0, 8).toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function buildMockPhone(userId: string): string {
  const digits = createHash("sha256").update(userId).digest("hex").replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
  return `+39${digits}`;
}

function maybePromoteToConnected(record: SessionRecord): SessionRecord {
  if (!record.autoConnectAt) {
    return record;
  }

  if (Date.parse(record.autoConnectAt) > Date.now()) {
    return record;
  }

  return {
    ...record,
    status: "connected",
    qrCodeDataUrl: null,
    qrCodeAscii: null,
    pairingCode: null,
    sessionPersisted: true,
    connectedAt: record.connectedAt ?? nowIso(),
    updatedAt: nowIso(),
    autoConnectAt: null,
  };
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  async initialize(record: SessionRecord, mode: ConnectionMode): Promise<SessionRecord> {
    return {
      ...record,
      status: mode === "pairing" ? "waiting_pairing" : "waiting_qr",
      connectionMode: mode,
      qrCodeDataUrl: mode === "qr" ? buildMockQrCode(record.userId, record.instanceId) : null,
      qrCodeAscii: null,
      pairingCode: mode === "pairing" ? buildMockPairingCode(record.userId) : null,
      phoneNumber: buildMockPhone(record.userId),
      lastError: null,
      sessionPersisted: false,
      connectedAt: null,
      isStale: false,
      staleReason: null,
      updatedAt: nowIso(),
      autoConnectAt: new Date(Date.now() + 15_000).toISOString(),
    };
  }

  async getStatus(record: SessionRecord): Promise<SessionRecord> {
    return maybePromoteToConnected({
      ...record,
      isStale: false,
      staleReason: null,
      updatedAt: nowIso(),
    });
  }

  async disconnect(record: SessionRecord): Promise<SessionRecord> {
    return {
      ...record,
      status: "disconnected",
      qrCodeDataUrl: null,
      qrCodeAscii: null,
      pairingCode: null,
      lastError: null,
      connectedAt: null,
      sessionPersisted: false,
      isStale: false,
      staleReason: null,
      updatedAt: nowIso(),
      autoConnectAt: null,
    };
  }
}
