import { Prisma, PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __botWorkerPrismaClient: PrismaClient | undefined;
}

export const prisma =
  globalThis.__botWorkerPrismaClient ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__botWorkerPrismaClient = prisma;
}

export function isMissingTableError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
    return true;
  }

  return error instanceof Error && /does not exist in the current database/i.test(error.message);
}
