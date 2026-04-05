import type { Request, Response } from "express";
import {
  ConnectionModeSchema,
  StartClientBotRequestSchema,
} from "@whatsapp-ai/shared";

import { currentPortalUser } from "../lib/currentPortalUser.js";
import { AuditService } from "../services/auditService.js";
import { BotService } from "../services/botService.js";

const botService = new BotService();
const auditService = new AuditService();

export async function getStatus(request: Request, response: Response) {
  const status = await botService.getStatus(request.auth!.sub);
  response.json(status);
}

export async function initConnection(request: Request, response: Response) {
  const mode = ConnectionModeSchema.parse(request.body?.mode ?? "qr");
  const status = await botService.initConnection(request.auth!.sub, mode);
  await auditService.safeLog({
    category: "bot",
    action: "init_connection",
    summary: `Avviata inizializzazione bot in modalita ${mode}.`,
    targetType: "bot_instance",
    targetId: status.instanceId,
    metadata: {
      mode,
      status: status.status,
      provider: status.provider,
    },
    user: currentPortalUser(request),
  });
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
  await auditService.safeLog({
    category: "bot",
    action: "disconnect",
    summary: "Disconnessione bot richiesta dal portale.",
    targetType: "bot_instance",
    targetId: status.instanceId,
    metadata: {
      status: status.status,
      provider: status.provider,
    },
    user: currentPortalUser(request),
  });
  response.json(status);
}

export async function startClientBot(request: Request, response: Response) {
  const payload = StartClientBotRequestSchema.parse(request.body ?? {});
  const user = currentPortalUser(request);
  const result = await botService.startClientBot(user, payload.directory);
  await auditService.safeLog({
    category: "bot",
    action: "start_client_bot",
    summary: "Avvio worker/bot client richiesto dal portale.",
    targetType: "client_bot",
    targetId: result.directory,
    metadata: {
      directory: result.directory,
      pid: result.pid ?? null,
      command: result.command ?? null,
      bootsWorker: result.bootsWorker ?? false,
    },
    user,
  });
  response.json(result);
}
