import { Prisma } from "@prisma/client";
import type { AuditEvent } from "@whatsapp-ai/shared";

import { isMissingTableError, prisma } from "../lib/prisma.js";
import { toIsoString } from "../lib/serialize.js";

type AuditEventInput = {
  userId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  category: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  metadata?: unknown;
};

function toAuditEvent(
  input: Awaited<ReturnType<typeof prisma.auditEvent.findMany>>[number],
): AuditEvent {
  return {
    id: input.id,
    userId: input.userId,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    category: input.category,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    summary: input.summary,
    metadata: input.metadata ?? null,
    createdAt: toIsoString(input.createdAt)!,
  };
}

export class AuditRepository {
  async create(input: AuditEventInput): Promise<AuditEvent> {
    const event = await prisma.auditEvent.create({
      data: {
        userId: input.userId ?? null,
        actorEmail: input.actorEmail ?? null,
        actorRole: input.actorRole ?? null,
        category: input.category,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        summary: input.summary,
        metadata:
          input.metadata === undefined || input.metadata === null
            ? undefined
            : (input.metadata as Prisma.InputJsonValue),
      },
    });

    return toAuditEvent(event);
  }

  async listRecent(limit = 80): Promise<AuditEvent[]> {
    try {
      const events = await prisma.auditEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return events.map(toAuditEvent);
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }

      return [];
    }
  }
}
