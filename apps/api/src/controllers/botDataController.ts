import type { Request, Response } from "express";

import { ExecuteBotSqlRequestSchema, SaveBotDataRequestSchema } from "@whatsapp-ai/shared";

import { currentPortalUser } from "../lib/currentPortalUser.js";
import { AuditService } from "../services/auditService.js";
import { BotDataService } from "../services/botDataService.js";

const botDataService = new BotDataService();
const auditService = new AuditService();

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
  await auditService.safeLog({
    category: "bot_data",
    action: "replace_rows",
    summary: `Aggiornata la tabella ${String(request.params.model)} dal portale.`,
    targetType: "table",
    targetId: String(request.params.model),
    metadata: {
      rowCount: result.rowCount,
    },
    user: currentPortalUser(request),
  });
  response.json(result);
}

export async function executeSql(request: Request, response: Response) {
  const payload = ExecuteBotSqlRequestSchema.parse(request.body);
  const result = await botDataService.executeSql(payload, request.auth?.role ?? null);
  await auditService.safeLog({
    category: "bot_data",
    action: "execute_sql",
    summary: `Eseguita query SQL ${result.statementType.toUpperCase()} in modalita ${result.mode}.`,
    targetType: "sql_console",
    targetId: result.statementType,
    metadata: {
      mode: result.mode,
      allowWrite: payload.allowWrite,
      rowCount: result.rowCount,
      affectedRows: result.affectedRows ?? null,
      sqlPreview: payload.sql.slice(0, 180),
    },
    user: currentPortalUser(request),
  });
  response.json(result);
}
