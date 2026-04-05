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

export const apiErrorSourceValues = ["api", "bot-worker", "network", "validation"] as const;
export const ApiErrorSourceSchema = z.enum(apiErrorSourceValues);
export type ApiErrorSource = z.infer<typeof ApiErrorSourceSchema>;

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  source: ApiErrorSourceSchema,
  retryable: z.boolean().default(false),
  statusCode: z.number().int().positive().optional(),
  details: z.unknown().optional(),
  traceId: z.string().nullable().optional(),
});
export type ApiErrorPayload = z.infer<typeof ApiErrorSchema>;

export const ErrorResponseSchema = z.object({
  error: ApiErrorSchema,
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const PortalUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  role: z.string(),
});
export type PortalUser = z.infer<typeof PortalUserSchema>;

const systemAdminRoles = new Set([
  "admin",
  "system_admin",
  "system-admin",
  "systemadmin",
  "super_admin",
  "superadmin",
  "sysadmin",
  "owner",
  "root",
]);

const operationsRoles = new Set([
  ...systemAdminRoles,
  "user",
  "manager",
  "operator",
  "staff",
  "reception",
  "receptionist",
]);

function normalizePortalRole(role: string | null | undefined) {
  return (role ?? "").trim().toLowerCase();
}

export function isSystemAdminRole(role: string | null | undefined) {
  return systemAdminRoles.has(normalizePortalRole(role));
}

export function canViewOperations(role: string | null | undefined) {
  return operationsRoles.has(normalizePortalRole(role));
}

export function canViewBotDiagnostics(role: string | null | undefined) {
  return operationsRoles.has(normalizePortalRole(role));
}

export function canViewAuditLog(role: string | null | undefined) {
  return isSystemAdminRole(role);
}

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
  qrCodeAscii: z.string().nullable().optional(),
  pairingCode: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  sessionPersisted: z.boolean(),
  connectedAt: z.string().nullable().optional(),
  isStale: z.boolean().default(false),
  staleReason: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type BotStatusResponse = z.infer<typeof BotStatusResponseSchema>;

export const BotDataFieldSchema = z.object({
  name: z.string(),
  dbName: z.string().nullable().optional(),
  type: z.string(),
  isRequired: z.boolean(),
  isList: z.boolean(),
  isId: z.boolean(),
  isUnique: z.boolean(),
  isReadOnly: z.boolean(),
  hasDefaultValue: z.boolean(),
  isGenerated: z.boolean().optional(),
  isUpdatedAt: z.boolean().optional(),
});
export type BotDataField = z.infer<typeof BotDataFieldSchema>;

export const BotDataModelSchema = z.object({
  name: z.string(),
  dbName: z.string().nullable().optional(),
  primaryKey: z.array(z.string()),
  fields: z.array(BotDataFieldSchema),
});
export type BotDataModel = z.infer<typeof BotDataModelSchema>;

export const BotDataModelsResponseSchema = z.object({
  models: z.array(BotDataModelSchema),
});
export type BotDataModelsResponse = z.infer<typeof BotDataModelsResponseSchema>;

export const BotDataRowSchema = z.record(z.string(), z.unknown());
export type BotDataRow = z.infer<typeof BotDataRowSchema>;

export const BotDataRowsResponseSchema = z.object({
  model: z.string(),
  rowCount: z.number().int().nonnegative(),
  rows: z.array(BotDataRowSchema),
  redactedColumns: z.array(z.string()).default([]),
});
export type BotDataRowsResponse = z.infer<typeof BotDataRowsResponseSchema>;

export const SaveBotDataRequestSchema = z.object({
  rows: z.array(BotDataRowSchema),
});
export type SaveBotDataRequest = z.infer<typeof SaveBotDataRequestSchema>;

export const sqlStatementTypeValues = [
  "select",
  "show",
  "explain",
  "insert",
  "update",
  "delete",
  "truncate",
] as const;
export const SqlStatementTypeSchema = z.enum(sqlStatementTypeValues);
export type SqlStatementType = z.infer<typeof SqlStatementTypeSchema>;

export const ExecuteBotSqlRequestSchema = z.object({
  sql: z.string().trim().min(1),
  allowWrite: z.boolean().default(false),
});
export type ExecuteBotSqlRequest = z.infer<typeof ExecuteBotSqlRequestSchema>;

export const ExecuteBotSqlResponseSchema = z.object({
  sql: z.string(),
  statementType: SqlStatementTypeSchema,
  mode: z.enum(["read", "write"]),
  rowCount: z.number().int().nonnegative(),
  affectedRows: z.number().int().nonnegative().nullable().optional(),
  columns: z.array(z.string()),
  rows: z.array(BotDataRowSchema),
  redactedColumns: z.array(z.string()).default([]),
  truncated: z.boolean().default(false),
});
export type ExecuteBotSqlResponse = z.infer<typeof ExecuteBotSqlResponseSchema>;

export const StartClientBotRequestSchema = z.object({
  directory: z.string().trim().min(1).optional(),
});
export type StartClientBotRequest = z.infer<typeof StartClientBotRequestSchema>;

export const StartClientBotResponseSchema = z.object({
  message: z.string(),
  directory: z.string(),
  pid: z.number().int().positive().nullable().optional(),
  command: z.string().optional(),
  bootsWorker: z.boolean().optional(),
});
export type StartClientBotResponse = z.infer<typeof StartClientBotResponseSchema>;

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

export const activitySeverityValues = ["info", "success", "warning", "error"] as const;
export const ActivitySeveritySchema = z.enum(activitySeverityValues);
export type ActivitySeverity = z.infer<typeof ActivitySeveritySchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorRole: z.string().nullable(),
  category: z.string(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  summary: z.string(),
  metadata: z.unknown().nullable().optional(),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEventsResponseSchema = z.object({
  events: z.array(AuditEventSchema),
});
export type AuditEventsResponse = z.infer<typeof AuditEventsResponseSchema>;

export const BotEventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  instanceId: z.string().nullable(),
  level: ActivitySeveritySchema,
  code: z.string(),
  status: BotStatusSchema.nullable(),
  provider: z.string().nullable(),
  message: z.string(),
  details: z.unknown().nullable().optional(),
  createdAt: z.string(),
});
export type BotEvent = z.infer<typeof BotEventSchema>;

export const BotEventsResponseSchema = z.object({
  events: z.array(BotEventSchema),
});
export type BotEventsResponse = z.infer<typeof BotEventsResponseSchema>;

export const BotDiagnosticsResponseSchema = z.object({
  currentStatus: BotStatusResponseSchema.nullable(),
  events: z.array(BotEventSchema),
});
export type BotDiagnosticsResponse = z.infer<typeof BotDiagnosticsResponseSchema>;

export const ClientContactViewSchema = z.object({
  type: z.string(),
  value: z.string(),
});
export type ClientContactView = z.infer<typeof ClientContactViewSchema>;

export const OperationsClientSchema = z.object({
  clientId: z.string(),
  fullName: z.string(),
  contacts: z.array(ClientContactViewSchema),
  appointmentsCount: z.number().int().nonnegative(),
  lastAppointmentAt: z.string().nullable(),
  nextAppointmentAt: z.string().nullable(),
  lastChatAt: z.string().nullable(),
});
export type OperationsClient = z.infer<typeof OperationsClientSchema>;

export const OperationsClientsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  clients: z.array(OperationsClientSchema),
});
export type OperationsClientsResponse = z.infer<typeof OperationsClientsResponseSchema>;

export const OperationsAppointmentSchema = z.object({
  appointmentId: z.string(),
  status: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  clientName: z.string(),
  clientPhone: z.string().nullable(),
  clientWhatsapp: z.string().nullable(),
  professionalName: z.string(),
  serviceNames: z.array(z.string()),
  serviceDurationMin: z.number().int().nonnegative(),
  calendarProvider: z.string().nullable(),
  calendarEventId: z.string().nullable(),
  confirmAskedAt: z.string().nullable(),
  reviewAskedAt: z.string().nullable(),
});
export type OperationsAppointment = z.infer<typeof OperationsAppointmentSchema>;

export const OperationsAppointmentsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  appointments: z.array(OperationsAppointmentSchema),
});
export type OperationsAppointmentsResponse = z.infer<typeof OperationsAppointmentsResponseSchema>;

export const OperationsSummarySchema = z.object({
  totalClients: z.number().int().nonnegative(),
  upcomingAppointments: z.number().int().nonnegative(),
  todayAppointments: z.number().int().nonnegative(),
  activeHolds: z.number().int().nonnegative(),
  activeChatSessions: z.number().int().nonnegative(),
  activeProfessionals: z.number().int().nonnegative(),
});
export type OperationsSummary = z.infer<typeof OperationsSummarySchema>;
