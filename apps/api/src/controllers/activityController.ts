import type { Request, Response } from "express";

import { ActivityService } from "../services/activityService.js";

const activityService = new ActivityService();

function parseLimit(input: unknown, fallback: number) {
  const parsed = Number.parseInt(String(input ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export async function getAuditEvents(request: Request, response: Response) {
  const result = await activityService.getAuditEvents(parseLimit(request.query.limit, 80));
  response.json(result);
}

export async function getBotEvents(request: Request, response: Response) {
  const result = await activityService.getBotEvents(request.auth!.sub, parseLimit(request.query.limit, 60));
  response.json(result);
}

export async function getBotDiagnostics(request: Request, response: Response) {
  const result = await activityService.getBotDiagnostics(request.auth!.sub, parseLimit(request.query.limit, 60));
  response.json(result);
}
