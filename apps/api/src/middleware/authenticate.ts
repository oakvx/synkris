import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import { getSessionTokenFromRequest, PUBLIC_SESSION_TOKEN } from "../lib/authCookies.js";
import { HttpError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/token.js";

export function authenticate(request: Request, _response: Response, next: NextFunction) {
  const token = resolveRequestToken(request);

  if (!token) {
    next(new HttpError(401, "Autenticazione richiesta."));
    return;
  }

  request.auth = verifyAccessToken(token, env.jwtSecret);
  next();
}

function resolveRequestToken(request: Request) {
  const authorization = request.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  return bearerToken && bearerToken !== PUBLIC_SESSION_TOKEN
    ? bearerToken
    : getSessionTokenFromRequest(request);
}

export function authenticateOptional(request: Request, _response: Response, next: NextFunction) {
  const token = resolveRequestToken(request);

  if (!token) {
    next();
    return;
  }

  try {
    request.auth = verifyAccessToken(token, env.jwtSecret);
  } catch {
    request.auth = undefined;
  }

  next();
}
