import { Router } from "express";

import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import {
  forgotPassword,
  login,
  me,
  register,
  resetPassword,
} from "../controllers/authController.js";

export const authRoutes = Router();

authRoutes.post("/register", asyncHandler(register));
authRoutes.post("/login", asyncHandler(login));
authRoutes.post("/forgot-password", asyncHandler(forgotPassword));
authRoutes.post("/reset-password", asyncHandler(resetPassword));
authRoutes.get("/me", authenticate, asyncHandler(me));
