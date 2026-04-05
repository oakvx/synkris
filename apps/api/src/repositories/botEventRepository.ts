import type { BotEvent } from "@whatsapp-ai/shared";

import { isMissingTableError, prisma } from "../lib/prisma.js";
import { toIsoString } from "../lib/serialize.js";

function toBotEvent(input: Awaited<ReturnType<typeof prisma.botEvent.findMany>>[number]): BotEvent {
  return {
    id: input.id,
    userId: input.userId,
    instanceId: input.instanceId,
    level: input.level as BotEvent["level"],
    code: input.code,
    status: input.status,
    provider: input.provider,
    message: input.message,
    details: input.details ?? null,
    createdAt: toIsoString(input.createdAt)!,
  };
}

export class BotEventRepository {
  async listRecentForUser(userId: string, limit = 60): Promise<BotEvent[]> {
    try {
      const events = await prisma.botEvent.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return events.map(toBotEvent);
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }

      return [];
    }
  }
}
