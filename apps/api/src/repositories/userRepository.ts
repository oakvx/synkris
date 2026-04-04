import type { User } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

export class UserRepository {
  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  createUser(input: { email: string; passwordHash: string; displayName: string }): Promise<User> {
    return prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
      },
    });
  }
}
