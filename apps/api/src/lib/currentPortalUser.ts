import type { Request } from "express";
import { PortalUserSchema, type PortalUser } from "@whatsapp-ai/shared";

export function currentPortalUser(request: Request): PortalUser {
  return PortalUserSchema.parse({
    id: request.auth!.sub,
    email: request.auth!.email,
    displayName: null,
    role: request.auth!.role,
  });
}
