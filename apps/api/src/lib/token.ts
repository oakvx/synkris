import { createHmac } from "node:crypto";

import { HttpError } from "./errors.js";

export type AccessTokenPayload = {
  sub: string;
  email: string;
  role: string;
  exp: number;
};

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url<T>(value: string): T {
  const raw = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(raw) as T;
}

function signSegment(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "exp">,
  secret: string,
  expiresInSeconds = 60 * 60 * 12,
): string {
  const completePayload: AccessTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };

  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = encodeBase64Url(JSON.stringify(completePayload));
  const signature = signSegment(`${header}.${body}`, secret);

  return `${header}.${body}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) {
    throw new HttpError(401, "Token non valido.");
  }

  const expectedSignature = signSegment(`${header}.${body}`, secret);
  if (expectedSignature !== signature) {
    throw new HttpError(401, "Token non valido.");
  }

  const payload = decodeBase64Url<AccessTokenPayload>(body);
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "Token scaduto.");
  }

  return payload;
}
