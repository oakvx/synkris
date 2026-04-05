import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";

import { env } from "./config/env.js";
import { isHttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/authRoutes.js";
import { botRoutes } from "./routes/botRoutes.js";
import { healthRoutes } from "./routes/healthRoutes.js";
import { settingsRoutes } from "./routes/settingsRoutes.js";

export function createApp() {
  const app = express();
  const allowDynamicDevelopmentOrigins = env.allowedOrigins.length === 0 && env.nodeEnv === "development";

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((request, response, next) => {
    response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    if (request.path.startsWith("/auth")) {
      response.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowDynamicDevelopmentOrigins || env.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin non consentita: ${origin}`));
      },
      credentials: true,
      maxAge: 60 * 10,
    }),
  );

  app.use(express.json({ limit: "128kb" }));

  app.use("/health", healthRoutes);
  app.use("/auth", authRoutes);
  app.use("/bot", botRoutes);
  app.use("/settings", settingsRoutes);

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

    if (isHttpError(error)) {
      response.status(error.statusCode).json({ error: error.toPayload(traceId) });
      return;
    }

    console.error(`[api] unexpected error ${traceId}`, error);
    response.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Errore interno del server.",
        source: "api",
        retryable: true,
        statusCode: 500,
        traceId,
      },
    });
  });

  return app;
}
