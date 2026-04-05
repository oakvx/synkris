import { Router } from "express";

import { getAuditEvents, getBotDiagnostics, getBotEvents } from "../controllers/activityController.js";
import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireSystemAdmin } from "../middleware/requireSystemAdmin.js";

export const activityRoutes = Router();

activityRoutes.use(authenticate);
activityRoutes.get("/bot", asyncHandler(getBotEvents));
activityRoutes.get("/bot/diagnostics", asyncHandler(getBotDiagnostics));
activityRoutes.get("/audit", requireSystemAdmin, asyncHandler(getAuditEvents));
