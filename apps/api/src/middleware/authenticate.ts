import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/token.js";

export function authenticate(request: Request, _response: Response, next: NextFunction) {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;

  if (!token) {
    next(new HttpError(401, "Autenticazione richiesta."));
    return;
  }

  request.auth = verifyAccessToken(token, env.jwtSecret);
  next();
}
