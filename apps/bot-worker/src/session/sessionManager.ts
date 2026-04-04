import { randomUUID } from "node:crypto";

import type { BotStatusResponse, ConnectionMode } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { SessionRecord, WhatsAppProvider } from "../providers/types.js";
import { FileSessionStore } from "../storage/fileSessionStore.js";

function nowIso() {
  return new Date().toISOString();
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

  private async loadOrCreateRecord(userId: string): Promise<SessionRecord> {
    const fromDisk = await this.store.read(userId);
    if (fromDisk) {
      return fromDisk;
    }

    const instance = await prisma.botInstance.findFirst({
      where: { userId, name: "default" },
      orderBy: { updatedAt: "desc" },
    });

    return {
      instanceId: instance?.id ?? randomUUID(),
      userId,
      provider: instance?.provider ?? env.provider,
      status: instance?.status ?? "disconnected",
      connectionMode: null,
      qrCodeDataUrl: instance?.qrCodeDataUrl ?? null,
      pairingCode: instance?.pairingCode ?? null,
      phoneNumber: instance?.phoneNumber ?? null,
      lastError: instance?.lastError ?? null,
      sessionPersisted: Boolean(instance?.sessionPath),
      connectedAt: instance?.connectedAt?.toISOString() ?? null,
      updatedAt: instance?.updatedAt?.toISOString() ?? nowIso(),
      autoConnectAt: null,
    };
  }

  private async syncDatabase(record: SessionRecord): Promise<BotStatusResponse> {
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

    return {
      instanceId: instance.id,
      userId: record.userId,
      provider: record.provider,
      status: record.status,
      connectionMode: record.connectionMode,
      qrCodeDataUrl: record.qrCodeDataUrl,
      pairingCode: record.pairingCode,
      phoneNumber: record.phoneNumber,
      lastError: record.lastError,
      sessionPersisted: record.sessionPersisted,
      connectedAt: record.connectedAt,
      updatedAt: record.updatedAt,
    };
  }
}

