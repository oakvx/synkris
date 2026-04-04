import { Router } from "express";

import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { login, me, register } from "../controllers/authController.js";

export const authRoutes = Router();

authRoutes.post("/register", asyncHandler(register));
authRoutes.post("/login", asyncHandler(login));
authRoutes.get("/me", authenticate, asyncHandler(me));
