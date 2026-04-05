import type { AuditEventsResponse, BotDiagnosticsResponse, BotEventsResponse } from "@whatsapp-ai/shared";

import { AuditRepository } from "../repositories/auditRepository.js";
import { BotEventRepository } from "../repositories/botEventRepository.js";
import { BotService } from "./botService.js";

export class ActivityService {
  constructor(
    private readonly auditRepository = new AuditRepository(),
    private readonly botEventRepository = new BotEventRepository(),
    private readonly botService = new BotService(),
  ) {}

  async getAuditEvents(limit = 80): Promise<AuditEventsResponse> {
    return {
      events: await this.auditRepository.listRecent(limit),
    };
  }

  async getBotEvents(userId: string, limit = 60): Promise<BotEventsResponse> {
    return {
      events: await this.botEventRepository.listRecentForUser(userId, limit),
    };
  }

  async getBotDiagnostics(userId: string, limit = 60): Promise<BotDiagnosticsResponse> {
    const [currentStatus, events] = await Promise.all([
      this.botService.getStatus(userId),
      this.botEventRepository.listRecentForUser(userId, limit),
    ]);

    return {
      currentStatus,
      events,
    };
  }
}
