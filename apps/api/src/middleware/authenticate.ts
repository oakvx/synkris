import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import { getSessionTokenFromRequest, PUBLIC_SESSION_TOKEN } from "../lib/authCookies.js";
import { HttpError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/token.js";

export function authenticate(request: Request, _response: Response, next: NextFunction) {
  const authorization = request.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  const token =
    bearerToken && bearerToken !== PUBLIC_SESSION_TOKEN ? bearerToken : getSessionTokenFromRequest(request);

  if (!token) {
    next(new HttpError(401, "Autenticazione richiesta."));
    return;
  }

  request.auth = verifyAccessToken(token, env.jwtSecret);
  next();
}
