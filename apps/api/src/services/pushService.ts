import type { PushConfigResponse, PushSubscriptionInput } from "@whatsapp-ai/shared";
import webpush from "web-push";

import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { PushSubscriptionRepository } from "../repositories/pushSubscriptionRepository.js";

type PortalPushPayload = {
  body: string;
  data?: Record<string, unknown>;
  tag?: string;
  title: string;
  url?: string;
};

function normalizePushErrorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = Number((error as { statusCode?: unknown }).statusCode);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

export class PushService {
  private readonly enabled: boolean;

  constructor(private readonly pushSubscriptionRepository = new PushSubscriptionRepository()) {
    this.enabled = Boolean(env.pushVapidPublicKey && env.pushVapidPrivateKey);

    if (this.enabled) {
      webpush.setVapidDetails(
        env.pushVapidSubject,
        env.pushVapidPublicKey!,
        env.pushVapidPrivateKey!,
      );
    }
  }

  getConfig(): PushConfigResponse {
    return {
      enabled: this.enabled,
      vapidPublicKey: this.enabled ? env.pushVapidPublicKey : null,
    };
  }

  isEnabled() {
    return this.enabled;
  }

  async saveSubscription(userId: string, subscription: PushSubscriptionInput, userAgent?: string | null) {
    this.assertEnabled();
    await this.pushSubscriptionRepository.save(userId, subscription, userAgent);
  }

  async deleteSubscription(userId: string, endpoint: string) {
    await this.pushSubscriptionRepository.deleteForUser(userId, endpoint);
  }

  async sendTestNotification(userId: string, recipientLabel: string | null | undefined) {
    const body = recipientLabel
      ? `Le notifiche push sono attive su questo device per ${recipientLabel}.`
      : "Le notifiche push sono attive su questo device.";

    return this.sendToSubscriptions(await this.pushSubscriptionRepository.listForUser(userId), {
      title: "Test notifiche push",
      body,
      tag: "portal-push-test",
      url: "/#/settings",
      data: { source: "manual_test" },
    });
  }

  async broadcastAppointmentEvent(payload: PortalPushPayload) {
    if (!this.enabled) {
      return 0;
    }

    return this.sendToSubscriptions(await this.pushSubscriptionRepository.listEnabledSubscriptions(), payload);
  }

  private async sendToSubscriptions(
    subscriptions: Array<{ endpoint: string; subscription: PushSubscriptionInput }>,
    payload: PortalPushPayload,
  ) {
    if (!this.enabled || subscriptions.length === 0) {
      return 0;
    }

    let delivered = 0;

    for (const item of subscriptions) {
      try {
        await webpush.sendNotification(item.subscription, JSON.stringify(payload), {
          TTL: 60,
          urgency: "high",
        });
        delivered += 1;
      } catch (error) {
        const statusCode = normalizePushErrorStatus(error);
        if (statusCode === 404 || statusCode === 410) {
          await this.pushSubscriptionRepository.deleteByEndpoint(item.endpoint);
          continue;
        }

        console.warn("[api] push notification failed", {
          endpoint: item.endpoint,
          statusCode,
          error,
        });
      }
    }

    return delivered;
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new HttpError(
        503,
        "Notifiche push non configurate sul server. Imposta le chiavi VAPID.",
        {
          code: "PUSH_NOT_CONFIGURED",
          retryable: false,
        },
      );
    }
  }
}

export const pushService = new PushService();
