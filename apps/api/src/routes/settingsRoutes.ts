import { Router } from "express";

import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { getSettings, updateSettings } from "../controllers/settingsController.js";

export const settingsRoutes = Router();

settingsRoutes.use(authenticate);
settingsRoutes.get("/", asyncHandler(getSettings));
settingsRoutes.put("/", asyncHandler(updateSettings));
