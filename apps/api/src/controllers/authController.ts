import type { Request, Response } from "express";
import {
  LoginRequestSchema,
  RegisterRequestSchema,
} from "@whatsapp-ai/shared";

import { AuthService } from "../services/authService.js";

const authService = new AuthService();

export async function register(request: Request, response: Response) {
  const payload = RegisterRequestSchema.parse(request.body);
  const result = await authService.register(payload);
  response.status(201).json(result);
}

export async function login(request: Request, response: Response) {
  const payload = LoginRequestSchema.parse(request.body);
  const result = await authService.login(payload);
  response.json(result);
}

export async function me(request: Request, response: Response) {
  const user = await authService.getMe(request.auth!.sub);
  response.json(user);
}
