import { Prisma } from "@prisma/client";
import { PushSubscriptionInputSchema, type PushSubscriptionInput } from "@whatsapp-ai/shared";

import { prisma } from "../lib/prisma.js";

type StoredSubscription = {
  endpoint: string;
  subscription: PushSubscriptionInput;
  userId: string;
};

function toJsonValue(input: PushSubscriptionInput): Prisma.InputJsonValue {
  return input as unknown as Prisma.InputJsonValue;
}

function parseStoredSubscription(endpoint: string, subscription: unknown, userId: string): StoredSubscription | null {
  try {
    return {
      endpoint,
      subscription: PushSubscriptionInputSchema.parse(subscription),
      userId,
    };
  } catch (error) {
    console.warn("[api] push subscription non valida nel database", { endpoint, userId, error });
    return null;
  }
}

export class PushSubscriptionRepository {
  async save(userId: string, subscription: PushSubscriptionInput, userAgent?: string | null) {
    await prisma.devicePushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        userId,
        endpoint: subscription.endpoint,
        subscription: toJsonValue(subscription),
        userAgent: userAgent ?? subscription.userAgent ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        userId,
        subscription: toJsonValue(subscription),
        userAgent: userAgent ?? subscription.userAgent ?? null,
        lastSeenAt: new Date(),
      },
    });
  }

  async deleteForUser(userId: string, endpoint: string) {
    await prisma.devicePushSubscription.deleteMany({
      where: {
        userId,
        endpoint,
      },
    });
  }

  async deleteByEndpoint(endpoint: string) {
    await prisma.devicePushSubscription.deleteMany({
      where: { endpoint },
    });
  }

  async listForUser(userId: string): Promise<StoredSubscription[]> {
    const rows = await prisma.devicePushSubscription.findMany({
      where: { userId },
      select: {
        endpoint: true,
        subscription: true,
        userId: true,
      },
    });

    return rows
      .map((row) => parseStoredSubscription(row.endpoint, row.subscription, row.userId))
      .filter((row): row is StoredSubscription => row !== null);
  }

  async listEnabledSubscriptions(): Promise<StoredSubscription[]> {
    const rows = await prisma.devicePushSubscription.findMany({
      where: {
        user: {
          OR: [
            { settings: null },
            { settings: { notificationsEnabled: true } },
          ],
        },
      },
      select: {
        endpoint: true,
        subscription: true,
        userId: true,
      },
    });

    return rows
      .map((row) => parseStoredSubscription(row.endpoint, row.subscription, row.userId))
      .filter((row): row is StoredSubscription => row !== null);
  }
}
