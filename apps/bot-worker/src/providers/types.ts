import type { BotStatus, ConnectionMode } from "@whatsapp-ai/shared";

export type SessionRecord = {
  instanceId: string;
  userId: string;
  provider: string;
  status: BotStatus;
  connectionMode: ConnectionMode | null;
  qrCodeDataUrl: string | null;
  qrCodeAscii: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  lastError: string | null;
  sessionPersisted: boolean;
  connectedAt: string | null;
  isStale: boolean;
  staleReason: string | null;
  updatedAt: string;
  autoConnectAt?: string | null;
};

export interface WhatsAppProvider {
  initialize(record: SessionRecord, mode: ConnectionMode): Promise<SessionRecord>;
  getStatus(record: SessionRecord): Promise<SessionRecord>;
  disconnect(record: SessionRecord): Promise<SessionRecord>;
}
