import { prisma } from "../lib/prisma.js";

export class PasswordResetRepository {
  async invalidateUserTokens(userId: string): Promise<void> {
    await prisma.passwordResetToken.updateMany({
      where: {
        userId,
        consumedAt: null,
      },
      data: {
        consumedAt: new Date(),
      },
    });
  }

  async createToken(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await prisma.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  findValidToken(tokenHash: string) {
    return prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        consumedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        user: true,
      },
    });
  }

  async consume(id: string): Promise<void> {
    await prisma.passwordResetToken.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }
}
