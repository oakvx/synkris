import { UserSettingsSchema, type PortalUser, type UserSettings } from "@whatsapp-ai/shared";

import { SettingsRepository } from "../repositories/settingsRepository.js";

export class SettingsService {
  constructor(private readonly settingsRepository = new SettingsRepository()) {}

  getSettings(user: PortalUser): Promise<UserSettings> {
    return this.settingsRepository.getOrCreate(user.id, {
      displayName: user.displayName ?? user.email,
    });
  }

  async updateSettings(user: PortalUser, input: UserSettings): Promise<UserSettings> {
    const payload = UserSettingsSchema.parse(input);
    return this.settingsRepository.save(user.id, payload);
  }
}
