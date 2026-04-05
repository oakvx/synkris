import type { Request, Response } from "express";

import { env } from "../config/env.js";

export const PUBLIC_SESSION_TOKEN = "session";

function cookieOptions() {
  return {
    httpOnly: true,
    maxAge: env.authSessionTtlSeconds * 1000,
    path: "/",
    sameSite: "lax" as const,
    secure: env.cookieSecure,
  };
}

function parseCookieHeader(cookieHeader: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of String(cookieHeader ?? "").split(";")) {
    const raw = part.trim();
    if (!raw) {
      continue;
    }

    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = raw.slice(0, eqIndex).trim();
    const value = raw.slice(eqIndex + 1).trim();
    if (!key) {
      continue;
    }

    out[key] = decodeURIComponent(value);
  }

  return out;
}

export function getSessionTokenFromRequest(request: Request): string | null {
  const cookies = parseCookieHeader(request.header("cookie"));
  return cookies[env.authCookieName] ?? null;
}

export function setSessionCookie(response: Response, token: string) {
  response.cookie(env.authCookieName, token, cookieOptions());
}

export function clearSessionCookie(response: Response) {
  response.clearCookie(env.authCookieName, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.cookieSecure,
  });
}
