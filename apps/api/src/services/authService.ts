import { AuthResponseSchema, type PortalUser } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signAccessToken } from "../lib/token.js";
import { SettingsRepository } from "../repositories/settingsRepository.js";
import { UserRepository } from "../repositories/userRepository.js";

function toPortalUser(input: { id: string; email: string; displayName: string | null; role: string }): PortalUser {
  return {
    id: input.id,
    email: input.email,
    displayName: input.displayName,
    role: input.role,
  };
}

export class AuthService {
  constructor(
    private readonly userRepository = new UserRepository(),
    private readonly settingsRepository = new SettingsRepository(),
  ) {}

  async register(input: { email: string; password: string; displayName: string }) {
    const existing = await this.userRepository.findByEmail(input.email);
    if (existing) {
      throw new HttpError(409, "Esiste già un utente con questa email.");
    }

    const user = await this.userRepository.createUser({
      email: input.email,
      passwordHash: hashPassword(input.password),
      displayName: input.displayName,
    });

    await this.settingsRepository.getOrCreate(user.id, {
      displayName: input.displayName,
    });

    return this.issueAuthResponse(user);
  }

  async login(input: { email: string; password: string }) {
    const user = await this.userRepository.findByEmail(input.email);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new HttpError(401, "Credenziali non valide.");
    }

    return this.issueAuthResponse(user);
  }

  async getMe(userId: string): Promise<PortalUser> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new HttpError(404, "Utente non trovato.");
    }

    return toPortalUser(user);
  }

  private issueAuthResponse(input: { id: string; email: string; displayName: string | null; role: string }) {
    const user = toPortalUser(input);
    const token = signAccessToken(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
      },
      env.jwtSecret,
    );

    return AuthResponseSchema.parse({ token, user });
  }
}
