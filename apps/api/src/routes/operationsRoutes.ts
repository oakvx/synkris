import { Router } from "express";

import {
  getOperationsSummary,
  listOperationsAppointments,
  listOperationsClients,
} from "../controllers/operationsController.js";
import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";

export const operationsRoutes = Router();

operationsRoutes.use(authenticate);
operationsRoutes.get("/summary", asyncHandler(getOperationsSummary));
operationsRoutes.get("/appointments", asyncHandler(listOperationsAppointments));
operationsRoutes.get("/clients", asyncHandler(listOperationsClients));
