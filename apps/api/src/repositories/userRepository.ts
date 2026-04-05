import type { User } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

export class UserRepository {
  countUsers(): Promise<number> {
    return prisma.user.count();
  }

  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  createUser(input: { email: string; passwordHash: string; displayName: string; role?: string }): Promise<User> {
    return prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        role: input.role ?? "user",
      },
    });
  }

  updatePassword(userId: string, passwordHash: string): Promise<User> {
    return prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }
}
