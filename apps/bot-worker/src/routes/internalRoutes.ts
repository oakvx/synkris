import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { ConnectionModeSchema } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { SessionManager } from "../session/sessionManager.js";

function requireInternalToken(request: Request, response: Response, next: NextFunction) {
  const receivedToken = request.header("x-internal-token");
  if (!receivedToken || receivedToken !== env.internalToken) {
    response.status(401).json({ error: "Unauthorized" });
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
