import {
  AuditEventsResponseSchema,
  AuthResponseSchema,
  BotDiagnosticsResponseSchema,
  BotEventsResponseSchema,
  BotDataModelsResponseSchema,
  BotDataRowsResponseSchema,
  BotStatusResponseSchema,
  ExecuteBotSqlResponseSchema,
  ErrorResponseSchema,
  OperationsAppointmentsResponseSchema,
  OperationsClientsResponseSchema,
  OperationsSummarySchema,
  ForgotPasswordResponseSchema,
  PortalUserSchema,
  PushConfigResponseSchema,
  PushSubscriptionDeleteSchema,
  PushSubscriptionResponseSchema,
  PushTestResponseSchema,
  StartClientBotResponseSchema,
  type ApiErrorPayload,
  type AuditEventsResponse,
  type ApiErrorSource,
  type AuthResponse,
  type BotDiagnosticsResponse,
  type BotEventsResponse,
  type BotDataModelsResponse,
  type BotDataRow,
  type BotDataRowsResponse,
  type BotStatusResponse,
  type ConnectionMode,
  type ExecuteBotSqlResponse,
  type ForgotPasswordResponse,
  type OperationsAppointmentsResponse,
  type OperationsClientsResponse,
  type OperationsSummary,
  type PortalUser,
  type PushConfigResponse,
  type PushSubscriptionDeleteInput,
  type PushSubscriptionInput,
  type PushSubscriptionResponse,
  type PushTestResponse,
  type StartClientBotResponse,
  type UserSettings,
  UserSettingsSchema,
} from "@whatsapp-ai/shared";

import { appConfig } from "../config";

type RequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
};

type ApiClientErrorInit = {
  code?: string;
  source?: ApiErrorSource;
  retryable?: boolean;
  statusCode?: number;
  details?: unknown;
  traceId?: string | null;
};

export class ApiClientError extends Error {
  readonly code: string;
  readonly source: ApiErrorSource;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly details?: unknown;
  readonly traceId: string | null;

  constructor(message: string, init: ApiClientErrorInit = {}) {
    super(message);
    this.name = "ApiClientError";
    this.code = init.code ?? "API_ERROR";
    this.source = init.source ?? "api";
    this.retryable = init.retryable ?? false;
    this.statusCode = init.statusCode;
    this.details = init.details;
    this.traceId = init.traceId ?? null;
  }
}

function buildApiClientError(
  payload: Partial<ApiErrorPayload> & { message: string },
  statusCode?: number,
): ApiClientError {
  return new ApiClientError(payload.message, {
    code: payload.code,
    source: payload.source,
    retryable: payload.retryable,
    statusCode: payload.statusCode ?? statusCode,
    details: payload.details,
    traceId: payload.traceId ?? null,
  });
}

function parseErrorPayload(rawPayload: unknown, statusCode: number): ApiClientError {
  const parsed = ErrorResponseSchema.safeParse(rawPayload);
  if (parsed.success) {
    return buildApiClientError(parsed.data.error, statusCode);
  }

  if (rawPayload && typeof rawPayload === "object" && "error" in rawPayload) {
    const legacyMessage = (rawPayload as Record<string, unknown>).error;
    if (typeof legacyMessage === "string" && legacyMessage.trim()) {
      return new ApiClientError(legacyMessage, {
        code: statusCode >= 500 ? "API_REQUEST_FAILED" : "API_BAD_REQUEST",
        source: "api",
        retryable: statusCode >= 500,
        statusCode,
      });
    }
  }

  return new ApiClientError("Richiesta fallita.", {
    code: statusCode >= 500 ? "API_REQUEST_FAILED" : "API_BAD_REQUEST",
    source: "api",
    retryable: statusCode >= 500,
    statusCode,
    details: rawPayload,
  });
}

export function getErrorMessage(error: unknown, fallback = "Operazione non riuscita."): string {
  if (error instanceof ApiClientError) {
    return error.message || fallback;
  }

  if (error instanceof Error) {
    return error.message || fallback;
  }

  return fallback;
}

export function isRetryableError(error: unknown): boolean {
  return error instanceof ApiClientError ? error.retryable : false;
}

function buildQueryString(input: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function isBearerToken(token: string | null | undefined) {
  if (!token) {
    return false;
  }

  return token.split(".").length === 3;
}

async function request<T>(
  path: string,
  options: RequestOptions,
  parser: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(isBearerToken(options.token) ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new ApiClientError("Impossibile contattare il server.", {
      code: "NETWORK_ERROR",
      source: "network",
      retryable: true,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const rawText = await response.text();
  let payload: unknown = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      payload = rawText;
    }
  }

  if (!response.ok) {
    throw parseErrorPayload(payload, response.status);
  }

  try {
    return parser(payload);
  } catch (error) {
    throw new ApiClientError("Risposta del server non valida.", {
      code: "INVALID_API_RESPONSE",
      source: "api",
      retryable: true,
      statusCode: response.status,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export const apiClient = {
  login(email: string, password: string): Promise<AuthResponse> {
    return request(
      "/auth/login",
      { method: "POST", body: { email, password } },
      (value) => AuthResponseSchema.parse(value),
    );
  },
  register(email: string, password: string, displayName: string): Promise<AuthResponse> {
    return request(
      "/auth/register",
      { method: "POST", body: { email, password, displayName } },
      (value) => AuthResponseSchema.parse(value),
    );
  },
  forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    return request(
      "/auth/forgot-password",
      { method: "POST", body: { email } },
      (value) => ForgotPasswordResponseSchema.parse(value),
    );
  },
  resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    return request(
      "/auth/reset-password",
      { method: "POST", body: { token, newPassword } },
      (value) => value as { message: string },
    );
  },
  logout(token?: string | null): Promise<{ message: string }> {
    return request("/auth/logout", { method: "POST", token }, (value) => value as { message: string });
  },
  me(token?: string | null): Promise<PortalUser> {
    return request("/auth/me", { token }, (value) => PortalUserSchema.parse(value));
  },
  getBotStatus(token?: string | null): Promise<BotStatusResponse> {
    return request("/bot/status", { token }, (value) => BotStatusResponseSchema.parse(value));
  },
  initBotConnection(token: string | null | undefined, mode: ConnectionMode): Promise<BotStatusResponse> {
    return request(
      "/bot/connect/init",
      { method: "POST", token, body: { mode } },
      (value) => BotStatusResponseSchema.parse(value),
    );
  },
  getQr(token: string | null | undefined): Promise<BotStatusResponse> {
    return request("/bot/connect/qr", { token }, (value) => BotStatusResponseSchema.parse(value));
  },
  getPairingCode(token: string | null | undefined): Promise<BotStatusResponse> {
    return request("/bot/connect/pairing-code", { token }, (value) => BotStatusResponseSchema.parse(value));
  },
  disconnectBot(token: string | null | undefined): Promise<BotStatusResponse> {
    return request("/bot/disconnect", { method: "POST", token }, (value) => BotStatusResponseSchema.parse(value));
  },
  getBotEvents(token: string | null | undefined, limit = 60): Promise<BotEventsResponse> {
    return request(
      `/activity/bot${buildQueryString({ limit })}`,
      { token },
      (value) => BotEventsResponseSchema.parse(value),
    );
  },
  getBotDiagnostics(token: string | null | undefined, limit = 60): Promise<BotDiagnosticsResponse> {
    return request(
      `/activity/bot/diagnostics${buildQueryString({ limit })}`,
      { token },
      (value) => BotDiagnosticsResponseSchema.parse(value),
    );
  },
  getAuditEvents(token: string | null | undefined, limit = 80): Promise<AuditEventsResponse> {
    return request(
      `/activity/audit${buildQueryString({ limit })}`,
      { token },
      (value) => AuditEventsResponseSchema.parse(value),
    );
  },
  startClientBot(token: string | null | undefined, directory?: string): Promise<StartClientBotResponse> {
    return request(
      "/bot/client/start",
      { method: "POST", token, body: directory?.trim() ? { directory } : {} },
      (value) => StartClientBotResponseSchema.parse(value),
    );
  },
  getBotDataModels(token: string | null | undefined): Promise<BotDataModelsResponse> {
    return request("/bot/db/models", { token }, (value) => BotDataModelsResponseSchema.parse(value));
  },
  getBotDataRows(token: string | null | undefined, model: string): Promise<BotDataRowsResponse> {
    return request(
      `/bot/db/${encodeURIComponent(model)}`,
      { token },
      (value) => BotDataRowsResponseSchema.parse(value),
    );
  },
  saveBotDataRows(token: string | null | undefined, model: string, rows: BotDataRow[]): Promise<BotDataRowsResponse> {
    return request(
      `/bot/db/${encodeURIComponent(model)}`,
      { method: "PUT", token, body: { rows } },
      (value) => BotDataRowsResponseSchema.parse(value),
    );
  },
  executeBotSql(token: string | null | undefined, sql: string, allowWrite = false): Promise<ExecuteBotSqlResponse> {
    return request(
      "/bot/db/sql",
      { method: "POST", token, body: { allowWrite, sql } },
      (value) => ExecuteBotSqlResponseSchema.parse(value),
    );
  },
  getOperationsSummary(token: string | null | undefined): Promise<OperationsSummary> {
    return request("/operations/summary", { token }, (value) => OperationsSummarySchema.parse(value));
  },
  getOperationsAppointments(
    token: string | null | undefined,
    filters: { from?: string | null; limit?: number; search?: string | null; status?: string | null; to?: string | null } = {},
  ): Promise<OperationsAppointmentsResponse> {
    return request(
      `/operations/appointments${buildQueryString(filters)}`,
      { token },
      (value) => OperationsAppointmentsResponseSchema.parse(value),
    );
  },
  getOperationsClients(
    token: string | null | undefined,
    filters: { limit?: number; search?: string | null } = {},
  ): Promise<OperationsClientsResponse> {
    return request(
      `/operations/clients${buildQueryString(filters)}`,
      { token },
      (value) => OperationsClientsResponseSchema.parse(value),
    );
  },
  getSettings(token: string | null | undefined): Promise<UserSettings> {
    return request("/settings", { token }, (value) => UserSettingsSchema.parse(value));
  },
  updateSettings(token: string | null | undefined, settings: UserSettings): Promise<UserSettings> {
    return request(
      "/settings",
      { method: "PUT", token, body: settings },
      (value) => UserSettingsSchema.parse(value),
    );
  },
  getPushConfig(token: string | null | undefined): Promise<PushConfigResponse> {
    return request("/notifications/config", { token }, (value) => PushConfigResponseSchema.parse(value));
  },
  savePushSubscription(
    token: string | null | undefined,
    subscription: PushSubscriptionInput,
  ): Promise<PushSubscriptionResponse> {
    return request(
      "/notifications/subscriptions",
      { method: "POST", token, body: subscription },
      (value) => PushSubscriptionResponseSchema.parse(value),
    );
  },
  deletePushSubscription(
    token: string | null | undefined,
    subscription: PushSubscriptionDeleteInput,
  ): Promise<PushSubscriptionResponse> {
    return request(
      "/notifications/subscriptions",
      {
        method: "DELETE",
        token,
        body: PushSubscriptionDeleteSchema.parse(subscription),
      },
      (value) => PushSubscriptionResponseSchema.parse(value),
    );
  },
  sendPushTest(token: string | null | undefined): Promise<PushTestResponse> {
    return request("/notifications/test", { method: "POST", token }, (value) => PushTestResponseSchema.parse(value));
  },
};
