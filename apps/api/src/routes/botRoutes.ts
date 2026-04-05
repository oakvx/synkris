import { Router } from "express";

import { executeSql, getRows, listModels, replaceRows } from "../controllers/botDataController.js";
import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireSystemAdmin } from "../middleware/requireSystemAdmin.js";
import {
  disconnect,
  getPairingCode,
  getQr,
  getStatus,
  initConnection,
  startClientBot,
} from "../controllers/botController.js";

export const botRoutes = Router();

botRoutes.use(authenticate);
botRoutes.get("/status", asyncHandler(getStatus));
botRoutes.post("/connect/init", asyncHandler(initConnection));
botRoutes.get("/connect/qr", asyncHandler(getQr));
botRoutes.get("/connect/pairing-code", asyncHandler(getPairingCode));
botRoutes.post("/disconnect", asyncHandler(disconnect));
botRoutes.post("/client/start", requireSystemAdmin, asyncHandler(startClientBot));
botRoutes.get("/db/models", requireSystemAdmin, asyncHandler(listModels));
botRoutes.post("/db/sql", requireSystemAdmin, asyncHandler(executeSql));
botRoutes.get("/db/:model", requireSystemAdmin, asyncHandler(getRows));
botRoutes.put("/db/:model", requireSystemAdmin, asyncHandler(replaceRows));
