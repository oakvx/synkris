import type { Request, Response } from "express";
import {
  PushConfigResponseSchema,
  PushSubscriptionDeleteSchema,
  PushSubscriptionInputSchema,
  PushSubscriptionResponseSchema,
  PushTestResponseSchema,
} from "@whatsapp-ai/shared";

import { currentPortalUser } from "../lib/currentPortalUser.js";
import { AuditService } from "../services/auditService.js";
import { pushService } from "../services/pushService.js";

const auditService = new AuditService();

export async function getPushConfig(_request: Request, response: Response) {
  response.json(PushConfigResponseSchema.parse(pushService.getConfig()));
}

export async function savePushSubscription(request: Request, response: Response) {
  const payload = PushSubscriptionInputSchema.parse({
    ...request.body,
    userAgent: request.body?.userAgent ?? request.get("user-agent") ?? null,
  });
  const user = currentPortalUser(request);

  await pushService.saveSubscription(user.id, payload, request.get("user-agent") ?? null);
  await auditService.safeLog({
    category: "push",
    action: "subscribe",
    summary: `Registrata una subscription push per ${user.email}.`,
    targetType: "device_push_subscription",
    targetId: payload.endpoint,
    metadata: {
      endpointPreview: payload.endpoint.slice(0, 80),
    },
    user,
  });

  response.json(PushSubscriptionResponseSchema.parse({ ok: true }));
}

export async function deletePushSubscription(request: Request, response: Response) {
  const payload = PushSubscriptionDeleteSchema.parse(request.body);
  const user = currentPortalUser(request);

  await pushService.deleteSubscription(user.id, payload.endpoint);
  await auditService.safeLog({
    category: "push",
    action: "unsubscribe",
    summary: `Rimossa una subscription push per ${user.email}.`,
    targetType: "device_push_subscription",
    targetId: payload.endpoint,
    metadata: {
      endpointPreview: payload.endpoint.slice(0, 80),
    },
    user,
  });

  response.json(PushSubscriptionResponseSchema.parse({ ok: true }));
}

export async function sendTestPushNotification(request: Request, response: Response) {
  const user = currentPortalUser(request);
  const delivered = await pushService.sendTestNotification(user.id, user.displayName ?? user.email);

  await auditService.safeLog({
    category: "push",
    action: "test_notification",
    summary: `Inviata una notifica push di test per ${user.email}.`,
    targetType: "user",
    targetId: user.id,
    metadata: {
      delivered,
    },
    user,
  });

  response.json(PushTestResponseSchema.parse({ delivered }));
}
