import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { ConnectionModeSchema } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { SessionManager } from "../session/sessionManager.js";

function requireInternalToken(request: Request, response: Response, next: NextFunction) {
  const receivedToken = request.header("x-internal-token");
  const expectedBuffer = Buffer.from(env.internalToken, "utf8");
  const receivedBuffer = Buffer.from(receivedToken ?? "", "utf8");
  const isValid =
    expectedBuffer.length > 0 &&
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer);

  if (!isValid) {
    response.status(401).json({
      error: {
        code: "INTERNAL_AUTH_FAILED",
        message: "Unauthorized",
        source: "bot-worker",
        retryable: false,
        statusCode: 401,
      },
    });
    return;
  }

  next();
}

export function createInternalRoutes(sessionManager: SessionManager) {
  const router = Router();

  router.use(requireInternalToken);

  router.get("/instances/:userId/status", async (request, response) => {
    const status = await sessionManager.getStatus(request.params.userId);
    response.json(status);
  });

  router.post("/instances/:userId/connect/init", async (request, response) => {
    const mode = ConnectionModeSchema.parse(request.body?.mode ?? "qr");
    const status = await sessionManager.initConnection(request.params.userId, mode);
    response.json(status);
  });

  router.get("/instances/:userId/connect/qr", async (request, response) => {
    const status = await sessionManager.getQr(request.params.userId);
    response.json(status);
  });

  router.get("/instances/:userId/connect/pairing-code", async (request, response) => {
    const status = await sessionManager.getPairingCode(request.params.userId);
    response.json(status);
  });

  router.post("/instances/:userId/disconnect", async (request, response) => {
    const status = await sessionManager.disconnect(request.params.userId);
    response.json(status);
  });

  return router;
}
