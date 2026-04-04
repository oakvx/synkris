import {
  InitConnectionRequestSchema,
  type BotStatusResponse,
  type ConnectionMode,
} from "@whatsapp-ai/shared";

import { BotWorkerClient } from "../clients/botWorkerClient.js";
import { BotRepository } from "../repositories/botRepository.js";

export class BotService {
  constructor(
    private readonly botWorkerClient = new BotWorkerClient(),
    private readonly botRepository = new BotRepository(),
  ) {}

  async getStatus(userId: string): Promise<BotStatusResponse> {
    try {
      return await this.botWorkerClient.getStatus(userId);
    } catch (error) {
      const snapshot = await this.botRepository.getDefaultInstanceSnapshot(userId);
      if (snapshot) {
        return snapshot;
      }
      throw error;
    }
  }

  initConnection(userId: string, mode: ConnectionMode): Promise<BotStatusResponse> {
    return this.botWorkerClient.initConnection(
      userId,
      InitConnectionRequestSchema.parse({ mode }),
    );
  }

  getQr(userId: string): Promise<BotStatusResponse> {
    return this.botWorkerClient.getQr(userId);
  }

  getPairingCode(userId: string): Promise<BotStatusResponse> {
    return this.botWorkerClient.getPairingCode(userId);
  }

  disconnect(userId: string): Promise<BotStatusResponse> {
    return this.botWorkerClient.disconnect(userId);
  }
}
