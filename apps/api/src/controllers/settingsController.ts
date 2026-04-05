import type { Request, Response } from "express";
import { UserSettingsSchema } from "@whatsapp-ai/shared";

import { currentPortalUser } from "../lib/currentPortalUser.js";
import { AuditService } from "../services/auditService.js";
import { SettingsService } from "../services/settingsService.js";

const settingsService = new SettingsService();
const auditService = new AuditService();

export async function getSettings(request: Request, response: Response) {
  const settings = await settingsService.getSettings(currentPortalUser(request));
  response.json(settings);
}

export async function updateSettings(request: Request, response: Response) {
  const payload = UserSettingsSchema.parse(request.body);
  const user = currentPortalUser(request);
  const settings = await settingsService.updateSettings(user, payload);
  await auditService.safeLog({
    category: "settings",
    action: "update_settings",
    summary: `Aggiornate le impostazioni dell'account ${user.email}.`,
    targetType: "user_settings",
    targetId: user.id,
    metadata: {
      preferredConnectionMode: settings.preferredConnectionMode,
      notificationsEnabled: settings.notificationsEnabled,
      timezone: settings.timezone,
      locale: settings.locale,
    },
    user,
  });
  response.json(settings);
}
