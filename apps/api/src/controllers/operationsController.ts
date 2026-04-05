import type { Request, Response } from "express";

import { OperationsService } from "../services/operationsService.js";

const operationsService = new OperationsService();

function parseLimit(input: unknown, fallback: number) {
  const parsed = Number.parseInt(String(input ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export async function getOperationsSummary(_request: Request, response: Response) {
  const result = await operationsService.getSummary();
  response.json(result);
}

export async function listOperationsAppointments(request: Request, response: Response) {
  const result = await operationsService.listAppointments({
    from: typeof request.query.from === "string" ? request.query.from : null,
    to: typeof request.query.to === "string" ? request.query.to : null,
    limit: parseLimit(request.query.limit, 40),
    search: typeof request.query.search === "string" ? request.query.search : null,
    status: typeof request.query.status === "string" ? request.query.status : null,
  });
  response.json(result);
}

export async function listOperationsClients(request: Request, response: Response) {
  const result = await operationsService.listClients({
    limit: parseLimit(request.query.limit, 50),
    search: typeof request.query.search === "string" ? request.query.search : null,
  });
  response.json(result);
}
