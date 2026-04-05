import type { Request, Response } from "express";

import { ExecuteBotSqlRequestSchema, SaveBotDataRequestSchema } from "@whatsapp-ai/shared";

import { BotDataService } from "../services/botDataService.js";

const botDataService = new BotDataService();

export async function listModels(_request: Request, response: Response) {
  response.json(botDataService.listModels());
}

export async function getRows(request: Request, response: Response) {
  const result = await botDataService.getRows(String(request.params.model), request.auth?.role ?? null);
  response.json(result);
}

export async function replaceRows(request: Request, response: Response) {
  const payload = SaveBotDataRequestSchema.parse(request.body);
  const result = await botDataService.replaceRows(String(request.params.model), payload, request.auth?.role ?? null);
  response.json(result);
}

export async function executeSql(request: Request, response: Response) {
  const payload = ExecuteBotSqlRequestSchema.parse(request.body);
  const result = await botDataService.executeSql(payload, request.auth?.role ?? null);
  response.json(result);
}
