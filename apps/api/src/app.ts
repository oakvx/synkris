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

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.allowedOrigins.length === 0 || env.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin non consentita: ${origin}`));
      },
      credentials: false,
    }),
  );

  app.use(express.json({ limit: "128kb" }));

  app.use("/health", healthRoutes);
  app.use("/auth", authRoutes);
  app.use("/bot", botRoutes);
  app.use("/settings", settingsRoutes);

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "Payload non valido.",
        details: error.flatten(),
      });
      return;
    }

    if (isHttpError(error)) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[api] unexpected error", error);
    response.status(500).json({ error: "Errore interno del server." });
  });

  return app;
}
