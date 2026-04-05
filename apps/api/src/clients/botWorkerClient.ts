import {
  BotStatusResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  InitConnectionRequestSchema,
  type BotStatusResponse,
  type HealthResponse,
  type InitConnectionRequest,
} from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";

export class BotWorkerClient {
  private async request<T>(
    path: string,
    options: RequestInit,
    parser: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${env.botWorkerBaseUrl}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "x-internal-token": env.internalServiceToken,
          ...(options.headers ?? {}),
        },
      });
    } catch (error) {
      throw new HttpError(503, "Impossibile contattare il bot worker.", {
        code: "BOT_WORKER_UNREACHABLE",
        source: "bot-worker",
        retryable: true,
        details: error instanceof Error ? error.message : String(error),
      });
    }

    const rawPayload = await response.text();
    let payload: unknown = null;
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload) as unknown;
      } catch {
        payload = rawPayload;
      }
    }

    if (!response.ok) {
      const parsedError = ErrorResponseSchema.safeParse(payload);
      if (parsedError.success) {
        const { error } = parsedError.data;
        throw new HttpError(response.status, error.message, {
          code: error.code,
          source: error.source,
          retryable: error.retryable,
          details: error.details,
          traceId: error.traceId ?? null,
        });
      }

      throw new HttpError(response.status, String(payload || "Errore dal bot worker."), {
        code: response.status >= 500 ? "BOT_WORKER_UPSTREAM_ERROR" : "BOT_WORKER_REQUEST_FAILED",
        source: "bot-worker",
        retryable: response.status >= 500,
      });
    }

    try {
      return parser(payload);
    } catch (error) {
      throw new HttpError(502, "Risposta non valida dal bot worker.", {
        code: "BOT_WORKER_INVALID_RESPONSE",
        source: "bot-worker",
        retryable: true,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getStatus(userId: string): Promise<BotStatusResponse> {
    return this.request(
      `/internal/instances/${userId}/status`,
      { method: "GET" },
      (value) => BotStatusResponseSchema.parse(value),
    );
  }

  getHealth(): Promise<HealthResponse> {
    return this.request(
      "/health",
      { method: "GET" },
      (value) => HealthResponseSchema.parse(value),
    );
  }

  initConnection(userId: string, payload: InitConnectionRequest): Promise<BotStatusResponse> {
    const body = InitConnectionRequestSchema.parse(payload);
    return this.request(
      `/internal/instances/${userId}/connect/init`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      (value) => BotStatusResponseSchema.parse(value),
    );
  }

  getQr(userId: string): Promise<BotStatusResponse> {
    return this.request(
      `/internal/instances/${userId}/connect/qr`,
      { method: "GET" },
      (value) => BotStatusResponseSchema.parse(value),
    );
  }

  getPairingCode(userId: string): Promise<BotStatusResponse> {
    return this.request(
      `/internal/instances/${userId}/connect/pairing-code`,
      { method: "GET" },
      (value) => BotStatusResponseSchema.parse(value),
    );
  }

  disconnect(userId: string): Promise<BotStatusResponse> {
    return this.request(
      `/internal/instances/${userId}/disconnect`,
      { method: "POST" },
      (value) => BotStatusResponseSchema.parse(value),
    );
  }
}
