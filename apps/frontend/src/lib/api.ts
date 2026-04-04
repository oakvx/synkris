import {
  AuthResponseSchema,
  BotStatusResponseSchema,
  ForgotPasswordResponseSchema,
  PortalUserSchema,
  type AuthResponse,
  type BotStatusResponse,
  type ConnectionMode,
  type ForgotPasswordResponse,
  type PortalUser,
  type UserSettings,
  UserSettingsSchema,
} from "@whatsapp-ai/shared";

import { appConfig } from "../config";

type RequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
};

async function request<T>(
  path: string,
  options: RequestOptions,
  parser: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error((payload.error as string | undefined) ?? "Richiesta fallita.");
  }

  return parser(payload);
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
  me(token: string): Promise<PortalUser> {
    return request("/auth/me", { token }, (value) => PortalUserSchema.parse(value));
  },
  getBotStatus(token: string): Promise<BotStatusResponse> {
    return request("/bot/status", { token }, (value) => BotStatusResponseSchema.parse(value));
  },
  initBotConnection(token: string, mode: ConnectionMode): Promise<BotStatusResponse> {
    return request(
      "/bot/connect/init",
      { method: "POST", token, body: { mode } },
      (value) => BotStatusResponseSchema.parse(value),
    );
  },
  getQr(token: string): Promise<BotStatusResponse> {
    return request("/bot/connect/qr", { token }, (value) => BotStatusResponseSchema.parse(value));
  },
  getPairingCode(token: string): Promise<BotStatusResponse> {
    return request("/bot/connect/pairing-code", { token }, (value) => BotStatusResponseSchema.parse(value));
  },
  disconnectBot(token: string): Promise<BotStatusResponse> {
    return request("/bot/disconnect", { method: "POST", token }, (value) => BotStatusResponseSchema.parse(value));
  },
  getSettings(token: string): Promise<UserSettings> {
    return request("/settings", { token }, (value) => UserSettingsSchema.parse(value));
  },
  updateSettings(token: string, settings: UserSettings): Promise<UserSettings> {
    return request(
      "/settings",
      { method: "PUT", token, body: settings },
      (value) => UserSettingsSchema.parse(value),
    );
  },
};
