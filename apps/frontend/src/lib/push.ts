import type { PushSubscriptionInput } from "@whatsapp-ai/shared";

import { apiClient } from "./api";

export type PushDeviceState = {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  supported: boolean;
};

function getBaseUrl() {
  return import.meta.env.BASE_URL || "/";
}

function getServiceWorkerUrl() {
  return `${getBaseUrl()}portal-sw.js`;
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function serializeSubscription(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      auth: json.keys?.auth ?? "",
      p256dh: json.keys?.p256dh ?? "",
    },
    userAgent: navigator.userAgent,
  };
}

async function ensureRegistration() {
  const scope = getBaseUrl();
  return navigator.serviceWorker.register(getServiceWorkerUrl(), { scope });
}

export function isPushSupported() {
  return typeof window !== "undefined"
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

export async function getPushDeviceState(token: string | null | undefined): Promise<PushDeviceState> {
  if (!isPushSupported()) {
    return {
      enabled: false,
      permission: "unsupported",
      subscribed: false,
      supported: false,
    };
  }

  const config = await apiClient.getPushConfig(token);
  const registration = await ensureRegistration();
  const subscription = await registration.pushManager.getSubscription();

  return {
    enabled: config.enabled,
    permission: Notification.permission,
    subscribed: Boolean(subscription),
    supported: true,
  };
}

export async function syncExistingPushSubscription(token: string | null | undefined) {
  if (!isPushSupported()) {
    return;
  }

  const config = await apiClient.getPushConfig(token);
  if (!config.enabled || Notification.permission !== "granted") {
    return;
  }

  const registration = await ensureRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }

  await apiClient.savePushSubscription(token, serializeSubscription(subscription));
}

export async function subscribeToPush(token: string | null | undefined): Promise<PushDeviceState> {
  if (!isPushSupported()) {
    throw new Error("Questo browser non supporta le notifiche push.");
  }

  const config = await apiClient.getPushConfig(token);
  if (!config.enabled || !config.vapidPublicKey) {
    throw new Error("Il server non ha ancora le notifiche push configurate.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      enabled: config.enabled,
      permission,
      subscribed: false,
      supported: true,
    };
  }

  const registration = await ensureRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
  }

  await apiClient.savePushSubscription(token, serializeSubscription(subscription));

  return {
    enabled: config.enabled,
    permission,
    subscribed: true,
    supported: true,
  };
}

export async function unsubscribeFromPush(token: string | null | undefined): Promise<PushDeviceState> {
  if (!isPushSupported()) {
    return {
      enabled: false,
      permission: "unsupported",
      subscribed: false,
      supported: false,
    };
  }

  const config = await apiClient.getPushConfig(token);
  const registration = await ensureRegistration();
  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    await apiClient.deletePushSubscription(token, { endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe();
  }

  return {
    enabled: config.enabled,
    permission: Notification.permission,
    subscribed: false,
    supported: true,
  };
}

export async function sendPushTest(token: string | null | undefined) {
  return apiClient.sendPushTest(token);
}
