import {
  ExecuteBotSqlRequestSchema,
  SaveBotDataRequestSchema,
  type BotDataModelsResponse,
  type BotDataRowsResponse,
  type ExecuteBotSqlResponse,
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

  getRows(model: string, role?: string | null): Promise<BotDataRowsResponse> {
    return this.botDataRepository.getRows(model, { role });
  }

  replaceRows(model: string, input: SaveBotDataRequest, role?: string | null): Promise<BotDataRowsResponse> {
    const payload = SaveBotDataRequestSchema.parse(input);
    return this.botDataRepository.replaceRows(model, payload.rows, { role });
  }

  executeSql(input: unknown, role?: string | null): Promise<ExecuteBotSqlResponse> {
    const payload = ExecuteBotSqlRequestSchema.parse(input);
    return this.botDataRepository.executeSql({ ...payload, role });
  }
}
