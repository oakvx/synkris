import type { PortalUser } from "@whatsapp-ai/shared";

import { AuditRepository } from "../repositories/auditRepository.js";

type AuditLogInput = {
  action: string;
  category: string;
  metadata?: unknown;
  summary: string;
  targetId?: string | null;
  targetType?: string | null;
  user?: PortalUser | null;
};

export class AuditService {
  constructor(private readonly auditRepository = new AuditRepository()) {}

  listRecent(limit?: number) {
    return this.auditRepository.listRecent(limit);
  }

  async log(input: AuditLogInput) {
    return this.auditRepository.create({
      userId: input.user?.id ?? null,
      actorEmail: input.user?.email ?? null,
      actorRole: input.user?.role ?? null,
      category: input.category,
      action: input.action,
      summary: input.summary,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
    });
  }

  async safeLog(input: AuditLogInput) {
    try {
      await this.log(input);
    } catch (error) {
      console.warn("[api] audit log failed", error);
    }
  }
}
