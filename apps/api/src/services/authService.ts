import { createHash, randomBytes } from "node:crypto";

import {
  AuthResponseSchema,
  ForgotPasswordResponseSchema,
  type PortalUser,
} from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signAccessToken } from "../lib/token.js";
import { PasswordResetRepository } from "../repositories/passwordResetRepository.js";
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

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  constructor(
    private readonly userRepository = new UserRepository(),
    private readonly settingsRepository = new SettingsRepository(),
    private readonly passwordResetRepository = new PasswordResetRepository(),
  ) {}

  async register(input: { email: string; password: string; displayName: string }) {
    const existing = await this.userRepository.findByEmail(input.email);
    if (existing) {
      throw new HttpError(409, "Esiste gia un utente con questa email.");
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

  async requestPasswordReset(email: string) {
    const genericResponse = {
      message: "Se l'email esiste, troverai un link di reset disponibile per l'ambiente corrente.",
      previewToken: null,
      previewUrl: null,
    };

    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      return ForgotPasswordResponseSchema.parse(genericResponse);
    }

    const rawToken = randomBytes(24).toString("hex");
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30);

    await this.passwordResetRepository.invalidateUserTokens(user.id);
    await this.passwordResetRepository.createToken({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const previewUrl = `${env.appBaseUrl}?resetToken=${rawToken}`;

    return ForgotPasswordResponseSchema.parse({
      message: genericResponse.message,
      previewToken: env.nodeEnv === "production" ? null : rawToken,
      previewUrl: env.nodeEnv === "production" ? null : previewUrl,
    });
  }

  async resetPassword(input: { token: string; newPassword: string }) {
    const tokenHash = hashResetToken(input.token);
    const resetToken = await this.passwordResetRepository.findValidToken(tokenHash);

    if (!resetToken) {
      throw new HttpError(400, "Token di reset non valido o scaduto.");
    }

    await this.userRepository.updatePassword(resetToken.userId, hashPassword(input.newPassword));
    await this.passwordResetRepository.consume(resetToken.id);
    await this.passwordResetRepository.invalidateUserTokens(resetToken.userId);

    return { message: "Password aggiornata correttamente." };
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
