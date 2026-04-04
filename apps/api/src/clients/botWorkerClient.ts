import {
  BotStatusResponseSchema,
  InitConnectionRequestSchema,
  type BotStatusResponse,
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
    const response = await fetch(`${env.botWorkerBaseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-internal-token": env.internalServiceToken,
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new HttpError(response.status, message || "Errore dal bot worker.");
    }

    const json = (await response.json()) as unknown;
    return parser(json);
  }

  getStatus(userId: string): Promise<BotStatusResponse> {
    return this.request(
      `/internal/instances/${userId}/status`,
      { method: "GET" },
      (value) => BotStatusResponseSchema.parse(value),
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
