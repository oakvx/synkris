import { randomUUID } from "node:crypto";
import express from "express";
import { ZodError } from "zod";

import { env } from "./config/env.js";
import { warn } from "./lib/logger.js";
import { MockWhatsAppProvider } from "./providers/mockWhatsAppProvider.js";
import { OpenWaLegacyProvider } from "./providers/openWaLegacyProvider.js";
import type { WhatsAppProvider } from "./providers/types.js";
import { createInternalRoutes } from "./routes/internalRoutes.js";
import { SessionManager } from "./session/sessionManager.js";
import { FileSessionStore } from "./storage/fileSessionStore.js";

function createProvider(): WhatsAppProvider {
  if (env.provider === "open-wa") {
    return new OpenWaLegacyProvider();
  }

  if (env.provider !== "mock") {
    warn(`Provider sconosciuto "${env.provider}", uso mock provider.`);
  }

  return new MockWhatsAppProvider();
}

export async function createApp() {
  const store = new FileSessionStore(env.sessionDir);
  await store.ensureBaseDir();

  const provider = createProvider();
  const sessionManager = new SessionManager(store, provider);

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "bot-worker",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/internal", createInternalRoutes(sessionManager));

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const traceId = randomUUID();

    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Payload non valido.",
          source: "validation",
          retryable: false,
          statusCode: 400,
          details: error.flatten(),
          traceId,
        },
      });
      return;
    }

    console.error(`[bot-worker] unexpected error ${traceId}`, error);
    response.status(500).json({
      error: {
        code: "BOT_WORKER_INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Errore interno del bot worker.",
        source: "bot-worker",
        retryable: true,
        statusCode: 500,
        traceId,
      },
    });
  });

  return app;
}
