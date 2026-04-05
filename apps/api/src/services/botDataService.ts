import {
  SaveBotDataRequestSchema,
  type BotDataModelsResponse,
  type BotDataRowsResponse,
  type SaveBotDataRequest,
} from "@whatsapp-ai/shared";

import { BotDataRepository } from "../repositories/botDataRepository.js";

export class BotDataService {
  constructor(private readonly botDataRepository = new BotDataRepository()) {}

  listModels(): BotDataModelsResponse {
    return {
      models: this.botDataRepository.listModels(),
    };
  }

  getRows(model: string): Promise<BotDataRowsResponse> {
    return this.botDataRepository.getRows(model);
  }

  replaceRows(model: string, input: SaveBotDataRequest): Promise<BotDataRowsResponse> {
    const payload = SaveBotDataRequestSchema.parse(input);
    return this.botDataRepository.replaceRows(model, payload.rows);
  }
}
