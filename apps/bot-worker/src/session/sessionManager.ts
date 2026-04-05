import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { BotStatusResponse, ConnectionMode } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { warn } from "../lib/logger.js";
import { isMissingTableError, prisma } from "../lib/prisma.js";
import type { SessionRecord, WhatsAppProvider } from "../providers/types.js";
import { FileSessionStore } from "../storage/fileSessionStore.js";

function nowIso() {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeStatus(status: SessionRecord["status"]) {
  switch (status) {
    case "connected":
      return "connesso";
    case "connecting":
      return "in connessione";
    case "waiting_qr":
      return "in attesa QR";
    case "waiting_pairing":
      return "in attesa pairing";
    case "error":
      return "in errore";
    default:
      return "disconnesso";
  }
}

function levelForStatus(status: SessionRecord["status"]) {
  switch (status) {
    case "connected":
      return "success";
    case "error":
      return "error";
    case "connecting":
    case "waiting_qr":
    case "waiting_pairing":
      return "warning";
    default:
      return "info";
  }
}

export class SessionManager {
  constructor(
    private readonly store: FileSessionStore,
    private readonly provider: WhatsAppProvider,
  ) {}

  async initConnection(userId: string, mode: ConnectionMode): Promise<BotStatusResponse> {
    const baseRecord = await this.loadOrCreateRecord(userId);
    const nextRecord = await this.provider.initialize(baseRecord, mode);
    await this.store.write(userId, nextRecord);
    return this.syncDatabase(nextRecord);
  }

  async getStatus(userId: string): Promise<BotStatusResponse> {
    const baseRecord = await this.loadOrCreateRecord(userId);
    const nextRecord = await this.provider.getStatus(baseRecord);
    await this.store.write(userId, nextRecord);
    return this.syncDatabase(nextRecord);
  }

  async getQr(userId: string): Promise<BotStatusResponse> {
    return this.getStatus(userId);
  }

  async getPairingCode(userId: string): Promise<BotStatusResponse> {
    return this.getStatus(userId);
  }

  async disconnect(userId: string): Promise<BotStatusResponse> {
    const baseRecord = await this.loadOrCreateRecord(userId);
    const nextRecord = await this.provider.disconnect(baseRecord);
    await this.store.write(userId, nextRecord);
    await this.store.remove(userId);
    return this.syncDatabase(nextRecord);
  }

  private async recordBotEvent(input: {
    code: string;
    details?: unknown;
    instanceId: string | null;
    level: "info" | "success" | "warning" | "error";
    message: string;
    provider: string;
    status: SessionRecord["status"] | null;
    userId: string;
  }) {
    await prisma.botEvent.create({
      data: {
        userId: input.userId,
        instanceId: input.instanceId,
        level: input.level,
        code: input.code,
        status: input.status,
        provider: input.provider,
        message: input.message,
        details:
          input.details === undefined || input.details === null
            ? undefined
            : (input.details as Prisma.InputJsonValue),
      },
    });
  }

  private async syncBotEventLog(
    record: SessionRecord,
    instanceId: string,
    previous: { id: string; lastError: string | null; status: SessionRecord["status"] } | null,
  ) {
    if (!previous) {
      await this.recordBotEvent({
        userId: record.userId,
        instanceId,
        provider: record.provider,
        code: "instance_registered",
        level: levelForStatus(record.status),
        status: record.status,
        message: `Istanza bot registrata con stato ${describeStatus(record.status)}.`,
        details: {
          connectionMode: record.connectionMode,
          sessionPersisted: record.sessionPersisted,
        },
      });
    } else if (previous.status !== record.status) {
      await this.recordBotEvent({
        userId: record.userId,
        instanceId,
        provider: record.provider,
        code: `status_${record.status}`,
        level: levelForStatus(record.status),
        status: record.status,
        message: `Stato bot passato da ${describeStatus(previous.status)} a ${describeStatus(record.status)}.`,
        details: {
          from: previous.status,
          to: record.status,
          connectionMode: record.connectionMode,
          sessionPersisted: record.sessionPersisted,
        },
      });
    }

    if (record.lastError && record.lastError !== previous?.lastError) {
      await this.recordBotEvent({
        userId: record.userId,
        instanceId,
        provider: record.provider,
        code: "provider_error",
        level: "error",
        status: record.status,
        message: record.lastError,
        details: {
          connectionMode: record.connectionMode,
          sessionPersisted: record.sessionPersisted,
        },
      });
    }
  }

  private async loadOrCreateRecord(userId: string): Promise<SessionRecord> {
    const fromDisk = await this.store.read(userId);
    if (fromDisk) {
      return {
        ...fromDisk,
        qrCodeAscii: fromDisk.qrCodeAscii ?? null,
        isStale: fromDisk.isStale ?? false,
        staleReason: fromDisk.staleReason ?? null,
      };
    }

    let instance: Awaited<ReturnType<typeof prisma.botInstance.findFirst>> | null = null;
    let settings: { phoneNumber: string | null; preferredConnectionMode: string } | null = null;

    try {
      [instance, settings] = await Promise.all([
        prisma.botInstance.findFirst({
          where: { userId, name: "default" },
          orderBy: { updatedAt: "desc" },
        }),
        prisma.userSettings.findUnique({
          where: { userId },
          select: {
            phoneNumber: true,
            preferredConnectionMode: true,
          },
        }),
      ]);
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }

      warn("Tabelle Prisma del portale mancanti nel bot-worker: uso fallback file-only.", toErrorMessage(error));
    }

    return {
      instanceId: instance?.id ?? randomUUID(),
      userId,
      provider: instance?.provider ?? env.provider,
      status: instance?.status ?? "disconnected",
      connectionMode: (instance?.status === "disconnected" ? settings?.preferredConnectionMode : null) as ConnectionMode | null,
      qrCodeDataUrl: instance?.qrCodeDataUrl ?? null,
      qrCodeAscii: null,
      pairingCode: instance?.pairingCode ?? null,
      phoneNumber: instance?.phoneNumber ?? settings?.phoneNumber ?? null,
      lastError: instance?.lastError ?? null,
      sessionPersisted: Boolean(instance?.sessionPath),
      connectedAt: instance?.connectedAt?.toISOString() ?? null,
      isStale: false,
      staleReason: null,
      updatedAt: instance?.updatedAt?.toISOString() ?? nowIso(),
      autoConnectAt: null,
    };
  }

  private async syncDatabase(record: SessionRecord): Promise<BotStatusResponse> {
    try {
      const previousInstance = await prisma.botInstance.findUnique({
        where: {
          userId_name: {
            userId: record.userId,
            name: "default",
          },
        },
        select: {
          id: true,
          status: true,
          lastError: true,
        },
      });

      const instance = await prisma.botInstance.upsert({
        where: {
          userId_name: {
            userId: record.userId,
            name: "default",
          },
        },
        create: {
          id: record.instanceId,
          userId: record.userId,
          name: "default",
          provider: record.provider,
          status: record.status,
          sessionPath: record.sessionPersisted ? this.store.resolvePath(record.userId) : null,
          qrCodeDataUrl: record.qrCodeDataUrl,
          pairingCode: record.pairingCode,
          phoneNumber: record.phoneNumber,
          lastError: record.lastError,
          connectedAt: record.connectedAt ? new Date(record.connectedAt) : null,
          lastHeartbeatAt: new Date(),
        },
        update: {
          provider: record.provider,
          status: record.status,
          sessionPath: record.sessionPersisted ? this.store.resolvePath(record.userId) : null,
          qrCodeDataUrl: record.qrCodeDataUrl,
          pairingCode: record.pairingCode,
          phoneNumber: record.phoneNumber,
          lastError: record.lastError,
          connectedAt: record.connectedAt ? new Date(record.connectedAt) : null,
          lastHeartbeatAt: new Date(),
        },
      });

      await prisma.botSessionMetadata.upsert({
        where: { instanceId: instance.id },
        create: {
          instanceId: instance.id,
          sessionKey: record.userId,
          providerSessionId: record.instanceId,
          isPersisted: record.sessionPersisted,
          lastSyncedAt: new Date(),
          metadata: {
            connectionMode: record.connectionMode,
          },
        },
        update: {
          sessionKey: record.userId,
          providerSessionId: record.instanceId,
          isPersisted: record.sessionPersisted,
          lastSyncedAt: new Date(),
          metadata: {
            connectionMode: record.connectionMode,
          },
        },
      });

      try {
        await this.syncBotEventLog(record, instance.id, previousInstance);
      } catch (error) {
        if (!isMissingTableError(error)) {
          throw error;
        }

        warn("Tabella bot_events non disponibile nel bot-worker: salto il logging eventi.", toErrorMessage(error));
      }

      return {
        instanceId: instance.id,
        userId: record.userId,
        provider: record.provider,
        status: record.status,
        connectionMode: record.connectionMode,
        qrCodeDataUrl: record.qrCodeDataUrl,
        qrCodeAscii: record.qrCodeAscii,
        pairingCode: record.pairingCode,
        phoneNumber: record.phoneNumber,
        lastError: record.lastError,
        sessionPersisted: record.sessionPersisted,
        connectedAt: record.connectedAt,
        isStale: record.isStale,
        staleReason: record.staleReason,
        updatedAt: record.updatedAt,
      };
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }

      warn("Persistenza Prisma non disponibile nel bot-worker: continuo in modalita' file-only.", toErrorMessage(error));
    }

    return {
      instanceId: record.instanceId,
      userId: record.userId,
      provider: record.provider,
      status: record.status,
      connectionMode: record.connectionMode,
      qrCodeDataUrl: record.qrCodeDataUrl,
      qrCodeAscii: record.qrCodeAscii,
      pairingCode: record.pairingCode,
      phoneNumber: record.phoneNumber,
      lastError: record.lastError,
      sessionPersisted: record.sessionPersisted,
      connectedAt: record.connectedAt,
      isStale: record.isStale,
      staleReason: record.staleReason,
      updatedAt: record.updatedAt,
    };
  }
}

