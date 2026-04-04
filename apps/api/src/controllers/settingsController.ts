import type { Request, Response } from "express";
import { PortalUserSchema, UserSettingsSchema } from "@whatsapp-ai/shared";

import { SettingsService } from "../services/settingsService.js";

const settingsService = new SettingsService();

function currentPortalUser(request: Request) {
  return PortalUserSchema.parse({
    id: request.auth!.sub,
    email: request.auth!.email,
    displayName: null,
    role: request.auth!.role,
  });
}

export async function getSettings(request: Request, response: Response) {
  const settings = await settingsService.getSettings(currentPortalUser(request));
  response.json(settings);
}

export async function updateSettings(request: Request, response: Response) {
  const payload = UserSettingsSchema.parse(request.body);
  const settings = await settingsService.updateSettings(currentPortalUser(request), payload);
  response.json(settings);
}
