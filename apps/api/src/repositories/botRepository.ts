import type { BotStatusResponse } from "@whatsapp-ai/shared";

import { prisma } from "../lib/prisma.js";

export class BotRepository {
  async getDefaultInstanceSnapshot(userId: string): Promise<BotStatusResponse | null> {
    const instance = await prisma.botInstance.findFirst({
      where: { userId, name: "default" },
      orderBy: { updatedAt: "desc" },
    });

    if (!instance) {
      return null;
    }

    return {
      instanceId: instance.id,
      userId: instance.userId,
      provider: instance.provider,
      status: instance.status,
      connectionMode: null,
      qrCodeDataUrl: instance.qrCodeDataUrl,
      pairingCode: instance.pairingCode,
      phoneNumber: instance.phoneNumber,
      lastError: instance.lastError,
      sessionPersisted: Boolean(instance.sessionPath),
      connectedAt: instance.connectedAt?.toISOString() ?? null,
      updatedAt: instance.updatedAt.toISOString(),
    };
  }
}
