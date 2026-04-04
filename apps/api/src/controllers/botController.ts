import type { Request, Response } from "express";
import { ConnectionModeSchema } from "@whatsapp-ai/shared";

import { BotService } from "../services/botService.js";

const botService = new BotService();

export async function getStatus(request: Request, response: Response) {
  const status = await botService.getStatus(request.auth!.sub);
  response.json(status);
}

export async function initConnection(request: Request, response: Response) {
  const mode = ConnectionModeSchema.parse(request.body?.mode ?? "qr");
  const status = await botService.initConnection(request.auth!.sub, mode);
  response.json(status);
}

export async function getQr(request: Request, response: Response) {
  const status = await botService.getQr(request.auth!.sub);
  response.json(status);
}

export async function getPairingCode(request: Request, response: Response) {
  const status = await botService.getPairingCode(request.auth!.sub);
  response.json(status);
}

export async function disconnect(request: Request, response: Response) {
  const status = await botService.disconnect(request.auth!.sub);
  response.json(status);
}
