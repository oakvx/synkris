import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionRecord } from "../providers/types.js";

export class FileSessionStore {
  constructor(private readonly baseDir: string) {}

  async ensureBaseDir() {
    await mkdir(this.baseDir, { recursive: true });
  }

  resolvePath(userId: string) {
    return path.join(this.baseDir, this.sanitizeSegment(userId), "session.json");
  }

  async read(userId: string): Promise<SessionRecord | null> {
    try {
      const raw = await readFile(this.resolvePath(userId), "utf8");
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  async write(userId: string, record: SessionRecord): Promise<void> {
    const filePath = this.resolvePath(userId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  }

  async remove(userId: string): Promise<void> {
    await rm(path.dirname(this.resolvePath(userId)), { recursive: true, force: true });
  }

  private sanitizeSegment(value: string) {
    return value.replace(/[^a-zA-Z0-9-_]/g, "_");
  }
}
