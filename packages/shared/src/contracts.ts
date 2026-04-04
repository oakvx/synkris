import { z } from "zod";

export const connectionModeValues = ["qr", "pairing"] as const;
export const botStatusValues = [
  "disconnected",
  "waiting_qr",
  "waiting_pairing",
  "connecting",
  "connected",
  "error",
] as const;

export const ConnectionModeSchema = z.enum(connectionModeValues);
export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;

export const BotStatusSchema = z.enum(botStatusValues);
export type BotStatus = z.infer<typeof BotStatusSchema>;

export const PortalUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  role: z.string(),
});
export type PortalUser = z.infer<typeof PortalUserSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RegisterRequestSchema = LoginRequestSchema.extend({
  displayName: z.string().trim().min(2).max(120),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ForgotPasswordResponseSchema = z.object({
  message: z.string(),
  previewToken: z.string().nullable().optional(),
  previewUrl: z.string().nullable().optional(),
});
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponseSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(8),
  newPassword: z.string().min(8),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: PortalUserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const UserSettingsSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(2).max(80),
  locale: z.string().trim().min(2).max(32),
  preferredConnectionMode: ConnectionModeSchema,
  phoneNumber: z.string().trim().max(32).nullable(),
  notificationsEnabled: z.boolean(),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const BotStatusResponseSchema = z.object({
  instanceId: z.string(),
  userId: z.string(),
  provider: z.string(),
  status: BotStatusSchema,
  connectionMode: ConnectionModeSchema.nullable().optional(),
  qrCodeDataUrl: z.string().nullable().optional(),
  pairingCode: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  sessionPersisted: z.boolean(),
  connectedAt: z.string().nullable().optional(),
  updatedAt: z.string(),
});
export type BotStatusResponse = z.infer<typeof BotStatusResponseSchema>;

export const InitConnectionRequestSchema = z.object({
  mode: ConnectionModeSchema.default("qr"),
});
export type InitConnectionRequest = z.infer<typeof InitConnectionRequestSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
