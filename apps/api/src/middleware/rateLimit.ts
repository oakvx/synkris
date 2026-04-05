import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../lib/errors.js";

type RateLimitOptions = {
  code?: string;
  keyGenerator?: (request: Request) => string;
  max: number;
  message: string;
  windowMs: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

function defaultKeyGenerator(request: Request) {
  return request.ip || request.socket.remoteAddress || "unknown";
}

export function createRateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, RateLimitBucket>();

  return function rateLimit(request: Request, _response: Response, next: NextFunction) {
    const now = Date.now();
    const key = options.keyGenerator?.(request) || defaultKeyGenerator(request);
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + options.windowMs,
      });
      next();
      return;
    }

    if (current.count >= options.max) {
      next(
        new HttpError(429, options.message, {
          code: options.code ?? "RATE_LIMITED",
          retryable: true,
          details: {
            retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
          },
        }),
      );
      return;
    }

    current.count += 1;
    buckets.set(key, current);
    next();
  };
}
