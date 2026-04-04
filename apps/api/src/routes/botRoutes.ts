import { Router } from "express";

import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import {
  disconnect,
  getPairingCode,
  getQr,
  getStatus,
  initConnection,
} from "../controllers/botController.js";

export const botRoutes = Router();

botRoutes.use(authenticate);
botRoutes.get("/status", asyncHandler(getStatus));
botRoutes.post("/connect/init", asyncHandler(initConnection));
botRoutes.get("/connect/qr", asyncHandler(getQr));
botRoutes.get("/connect/pairing-code", asyncHandler(getPairingCode));
botRoutes.post("/disconnect", asyncHandler(disconnect));
