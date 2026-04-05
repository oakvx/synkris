import type { Request, Response } from "express";
import {
  AuthResponseSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
} from "@whatsapp-ai/shared";

import { clearSessionCookie, PUBLIC_SESSION_TOKEN, setSessionCookie } from "../lib/authCookies.js";
import { currentPortalUser } from "../lib/currentPortalUser.js";
import { AuthService } from "../services/authService.js";
import { AuditService } from "../services/auditService.js";

const authService = new AuthService();
const auditService = new AuditService();

export async function register(request: Request, response: Response) {
  const payload = RegisterRequestSchema.parse(request.body);
  const result = await authService.register(payload);
  setSessionCookie(response, result.sessionToken);
  await auditService.safeLog({
    category: "auth",
    action: "register",
    summary: `Creato nuovo account portale per ${result.user.email}.`,
    targetType: "user",
    targetId: result.user.id,
    user: result.user,
  });
  response.status(201).json(AuthResponseSchema.parse({ token: PUBLIC_SESSION_TOKEN, user: result.user }));
}

export async function login(request: Request, response: Response) {
  const payload = LoginRequestSchema.parse(request.body);
  const result = await authService.login(payload);
  setSessionCookie(response, result.sessionToken);
  await auditService.safeLog({
    category: "auth",
    action: "login",
    summary: `Login completato per ${result.user.email}.`,
    targetType: "user",
    targetId: result.user.id,
    user: result.user,
  });
  response.json(AuthResponseSchema.parse({ token: PUBLIC_SESSION_TOKEN, user: result.user }));
}

export async function forgotPassword(request: Request, response: Response) {
  const payload = ForgotPasswordRequestSchema.parse(request.body);
  const result = await authService.requestPasswordReset(payload.email);
  await auditService.safeLog({
    category: "auth",
    action: "forgot_password",
    summary: `Richiesta reset password per ${payload.email}.`,
    targetType: "user_email",
    targetId: payload.email,
    metadata: {
      previewAvailable: Boolean(result.previewToken || result.previewUrl),
    },
    user: null,
  });
  response.json(result);
}

export async function resetPassword(request: Request, response: Response) {
  const payload = ResetPasswordRequestSchema.parse(request.body);
  const result = await authService.resetPassword(payload);
  await auditService.safeLog({
    category: "auth",
    action: "reset_password",
    summary: "Password aggiornata tramite token di reset.",
    targetType: "password_reset",
    user: null,
  });
  response.json(result);
}

export async function me(request: Request, response: Response) {
  const user = await authService.getMe(request.auth!.sub);
  response.json(user);
}

export async function logout(request: Request, response: Response) {
  clearSessionCookie(response);
  if (request.auth) {
    await auditService.safeLog({
      category: "auth",
      action: "logout",
      summary: `Logout eseguito da ${request.auth.email}.`,
      targetType: "user",
      targetId: request.auth.sub,
      user: currentPortalUser(request),
    });
  }
  response.json({ message: "Sessione terminata." });
}
