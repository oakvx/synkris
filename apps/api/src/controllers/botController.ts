import type { Request, Response } from "express";
import {
  ConnectionModeSchema,
  PortalUserSchema,
  StartClientBotRequestSchema,
} from "@whatsapp-ai/shared";

import { BotService } from "../services/botService.js";

const botService = new BotService();

function currentPortalUser(request: Request) {
  return PortalUserSchema.parse({
    id: request.auth!.sub,
    email: request.auth!.email,
    displayName: null,
    role: request.auth!.role,
  });
}

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

export async function startClientBot(request: Request, response: Response) {
  const payload = StartClientBotRequestSchema.parse(request.body ?? {});
  const result = await botService.startClientBot(currentPortalUser(request), payload.directory);
  response.json(result);
}
