import { type Request, Router } from "express";

import { asyncHandler } from "../lib/http.js";
import { authenticate } from "../middleware/authenticate.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import {
  forgotPassword,
  login,
  logout,
  me,
  register,
  resetPassword,
} from "../controllers/authController.js";

export const authRoutes = Router();

const authKeyFromIpAndEmail = (request: Request) => {
  const ip = request.ip || request.socket.remoteAddress || "unknown";
  const email =
    typeof request.body?.email === "string"
      ? request.body.email.trim().toLowerCase()
      : "";
  return `${ip}:${email}`;
};

const registerLimiter = createRateLimit({
  code: "REGISTER_RATE_LIMITED",
  keyGenerator: authKeyFromIpAndEmail,
  max: 5,
  message: "Hai effettuato troppi tentativi di registrazione. Riprova tra poco.",
  windowMs: 15 * 60 * 1000,
});

const loginLimiter = createRateLimit({
  code: "LOGIN_RATE_LIMITED",
  keyGenerator: authKeyFromIpAndEmail,
  max: 10,
  message: "Troppi tentativi di login. Attendi qualche minuto e riprova.",
  windowMs: 15 * 60 * 1000,
});

const forgotPasswordLimiter = createRateLimit({
  code: "PASSWORD_RESET_REQUEST_RATE_LIMITED",
  keyGenerator: authKeyFromIpAndEmail,
  max: 5,
  message: "Hai richiesto troppi reset password. Riprova piu tardi.",
  windowMs: 30 * 60 * 1000,
});

const resetPasswordLimiter = createRateLimit({
  code: "PASSWORD_RESET_RATE_LIMITED",
  keyGenerator(request) {
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const token =
      typeof request.body?.token === "string"
        ? request.body.token.trim().slice(0, 16)
        : "";
    return `${ip}:${token}`;
  },
  max: 8,
  message: "Troppi tentativi di reset password. Riprova piu tardi.",
  windowMs: 30 * 60 * 1000,
});

authRoutes.post("/register", registerLimiter, asyncHandler(register));
authRoutes.post("/login", loginLimiter, asyncHandler(login));
authRoutes.post("/forgot-password", forgotPasswordLimiter, asyncHandler(forgotPassword));
authRoutes.post("/reset-password", resetPasswordLimiter, asyncHandler(resetPassword));
authRoutes.get("/me", authenticate, asyncHandler(me));
authRoutes.post("/logout", asyncHandler(logout));
