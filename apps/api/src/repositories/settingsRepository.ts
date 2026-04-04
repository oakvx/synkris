import type { UserSettings } from "@whatsapp-ai/shared";

import { prisma } from "../lib/prisma.js";

export class SettingsRepository {
  async getOrCreate(userId: string, defaults: { displayName: string }): Promise<UserSettings> {
    const settings = await prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        displayName: defaults.displayName,
      },
      update: {},
    });

    return {
      displayName: settings.displayName,
      timezone: settings.timezone,
      locale: settings.locale,
      preferredConnectionMode: settings.preferredConnectionMode as UserSettings["preferredConnectionMode"],
      phoneNumber: settings.phoneNumber,
      notificationsEnabled: settings.notificationsEnabled,
    };
  }

  async save(userId: string, input: UserSettings): Promise<UserSettings> {
    const settings = await prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        displayName: input.displayName,
        timezone: input.timezone,
        locale: input.locale,
        preferredConnectionMode: input.preferredConnectionMode,
        phoneNumber: input.phoneNumber,
        notificationsEnabled: input.notificationsEnabled,
      },
      update: {
        displayName: input.displayName,
        timezone: input.timezone,
        locale: input.locale,
        preferredConnectionMode: input.preferredConnectionMode,
        phoneNumber: input.phoneNumber,
        notificationsEnabled: input.notificationsEnabled,
      },
    });

    return {
      displayName: settings.displayName,
      timezone: settings.timezone,
      locale: settings.locale,
      preferredConnectionMode: settings.preferredConnectionMode as UserSettings["preferredConnectionMode"],
      phoneNumber: settings.phoneNumber,
      notificationsEnabled: settings.notificationsEnabled,
    };
  }
}
