import { Router } from "express";

import {
  deletePushSubscription,
  getPushConfig,
  savePushSubscription,
  sendTestPushNotification,
} from "../controllers/notificationsController.js";
import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";

export const notificationsRoutes = Router();

notificationsRoutes.use(authenticate);
notificationsRoutes.get("/config", asyncHandler(getPushConfig));
notificationsRoutes.post("/subscriptions", asyncHandler(savePushSubscription));
notificationsRoutes.delete("/subscriptions", asyncHandler(deletePushSubscription));
notificationsRoutes.post("/test", asyncHandler(sendTestPushNotification));
