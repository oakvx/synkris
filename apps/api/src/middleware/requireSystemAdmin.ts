import type { NextFunction, Request, Response } from "express";

import { isSystemAdminRole } from "@whatsapp-ai/shared";

import { HttpError } from "../lib/errors.js";

export function requireSystemAdmin(request: Request, _response: Response, next: NextFunction) {
  if (!isSystemAdminRole(request.auth?.role)) {
    next(
      new HttpError(403, "Questa operazione e' riservata al system admin.", {
        code: "SYSTEM_ADMIN_REQUIRED",
        retryable: false,
      }),
    );
    return;
  }

  next();
}
