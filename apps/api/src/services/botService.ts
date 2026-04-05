import {
  InitConnectionRequestSchema,
  type PortalUser,
  type BotStatusResponse,
  type ConnectionMode,
  type StartClientBotResponse,
} from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { BotWorkerClient } from "../clients/botWorkerClient.js";
import { HttpError, isHttpError } from "../lib/errors.js";
import { BotRepository } from "../repositories/botRepository.js";
import { LegacyBotLauncherService } from "./legacyBotLauncherService.js";

export class BotService {
  constructor(
    private readonly botWorkerClient = new BotWorkerClient(),
    private readonly botRepository = new BotRepository(),
    private readonly legacyBotLauncherService = new LegacyBotLauncherService(),
  ) {}

  private buildUnavailableStatus(userId: string): BotStatusResponse {
    return {
      instanceId: `local-fallback-${userId}`,
      userId,
      provider: "local",
      status: "disconnected",
      connectionMode: null,
      qrCodeDataUrl: null,
      qrCodeAscii: null,
      pairingCode: null,
      phoneNumber: null,
      lastError: null,
      sessionPersisted: false,
      connectedAt: null,
      isStale: true,
      staleReason:
        "Il bot worker non e' attivo. Se stai lavorando in locale, usa 'Avvia worker locale': il portale avviera' solo il bot worker necessario per QR, pairing e connessione WhatsApp reale.",
      updatedAt: new Date().toISOString(),
    };
  }

  private buildStaleStatusFromSnapshot(
    userId: string,
    snapshot: BotStatusResponse | null,
    staleReason: string,
  ): BotStatusResponse {
    if (snapshot) {
      return {
        ...snapshot,
        isStale: true,
        staleReason,
      };
    }

    return {
      ...this.buildUnavailableStatus(userId),
      staleReason,
    };
  }

  private rethrowWithWorkerGuidance(error: unknown, actionLabel: string): never {
    if (isHttpError(error) && error.code === "BOT_WORKER_UNREACHABLE") {
      throw new HttpError(
        503,
        `${actionLabel} richiede il bot worker attivo su localhost:4001. Se stai usando il progetto locale, usa 'Avvia worker locale': il portale avviera' solo il bot worker, senza lanciare npm start del bot legacy.`,
        {
          code: "BOT_WORKER_REQUIRED",
          source: "api",
          retryable: true,
          details: error.toPayload(),
        },
      );
    }

    throw error;
  }

  private async isWorkerReachable(): Promise<boolean> {
    try {
      await this.botWorkerClient.getHealth();
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(userId: string): Promise<BotStatusResponse> {
    try {
      return await this.botWorkerClient.getStatus(userId);
    } catch (error) {
      const snapshot = await this.botRepository.getDefaultInstanceSnapshot(userId);
      if (isHttpError(error) && error.code === "BOT_WORKER_UNREACHABLE") {
        return this.buildStaleStatusFromSnapshot(
          userId,
          snapshot,
          "Il bot worker non e' raggiungibile: sto mostrando l'ultimo snapshot salvato.",
        );
      }

      if (isHttpError(error)) {
        return this.buildStaleStatusFromSnapshot(
          userId,
          snapshot,
          `Il bot worker risponde ma non riesce a fornire uno stato valido: ${error.message}`,
        );
      }

      return this.buildStaleStatusFromSnapshot(
        userId,
        snapshot,
        "Il bot worker non ha restituito uno stato utilizzabile: sto mostrando l'ultimo snapshot salvato.",
      );
    }
  }

  async initConnection(userId: string, mode: ConnectionMode): Promise<BotStatusResponse> {
    try {
      return await this.botWorkerClient.initConnection(
        userId,
        InitConnectionRequestSchema.parse({ mode }),
      );
    } catch (error) {
      this.rethrowWithWorkerGuidance(error, "La connessione con QR o pairing");
    }
  }

  async getQr(userId: string): Promise<BotStatusResponse> {
    try {
      return await this.botWorkerClient.getQr(userId);
    } catch (error) {
      this.rethrowWithWorkerGuidance(error, "L'aggiornamento del QR");
    }
  }

  async getPairingCode(userId: string): Promise<BotStatusResponse> {
    try {
      return await this.botWorkerClient.getPairingCode(userId);
    } catch (error) {
      this.rethrowWithWorkerGuidance(error, "L'aggiornamento del pairing code");
    }
  }

  async disconnect(userId: string): Promise<BotStatusResponse> {
    try {
      return await this.botWorkerClient.disconnect(userId);
    } catch (error) {
      this.rethrowWithWorkerGuidance(error, "La disconnessione remota");
    }
  }

  async startClientBot(user: PortalUser, directory?: string): Promise<StartClientBotResponse> {
    if (!env.allowClientBotStart) {
      throw new HttpError(403, "L'avvio remoto del bot client e' disabilitato in questo ambiente.", {
        code: "CLIENT_BOT_START_DISABLED",
      });
    }

    if (!directory?.trim() && await this.isWorkerReachable()) {
      const localDefaultDirectory = await this.legacyBotLauncherService.resolveLocalDefaultDirectory();
      return {
        message: "Il bot worker locale e' gia' attivo. Puoi procedere subito con QR o pairing code.",
        directory: localDefaultDirectory,
        pid: null,
        command: "already-running",
        bootsWorker: false,
      };
    }

    return this.legacyBotLauncherService.start(user, directory);
  }
}
