import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { PortalUser, StartClientBotResponse } from "@whatsapp-ai/shared";

import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl") as {
  open: (
    zipPath: string,
    options: { lazyEntries: boolean },
    callback: (error: Error | null, zipFile?: ZipFileHandle) => void,
  ) => void;
};

type ZipEntryHandle = {
  fileName: string;
};

type ZipFileHandle = {
  close: () => void;
  on: {
    (event: "entry", listener: (entry: ZipEntryHandle) => void): ZipFileHandle;
    (event: "end", listener: () => void): ZipFileHandle;
    (event: "error", listener: (error: Error) => void): ZipFileHandle;
  };
  openReadStream: (
    entry: ZipEntryHandle,
    callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
  ) => void;
  readEntry: () => void;
};

type ResolvedClientDirectory = {
  archivePath: string | null;
  directory: string;
  source: "manual" | "server" | "local-default";
};

type StartTargetResult = {
  commandLabel: string;
  pid: number | null;
  bootsWorker: boolean;
};

const deploymentCacheDirectoryName = ".launcher-cache";
const ignoredDirectoryNames = new Set([".git", deploymentCacheDirectoryName, "node_modules", "dist", "build", "coverage"]);

function sanitizeSegment(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isPathInside(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecordError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function escapePowerShellSingleQuotedValue(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeZipEntryPath(entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return path.join(...segments);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRoot(startDirectory: string): Promise<string | null> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const packageJsonPath = path.join(currentDirectory, "package.json");
    if (await pathExists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
          name?: string;
          workspaces?: unknown;
        };
        if (packageJson.name === "whatsapp-ai" || Array.isArray(packageJson.workspaces)) {
          return currentDirectory;
        }
      } catch {
        // ignore malformed package.json while walking upward
      }
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

export class LegacyBotLauncherService {
  private readonly serviceDirectory = path.dirname(fileURLToPath(import.meta.url));

  private async startCommandInWindowsTerminal(directory: string, commandArgs: string[], errorPrefix: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn("cmd.exe", ["/d", "/k", ...commandArgs], {
        cwd: directory,
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: false,
      });

      let settled = false;
      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        handler();
      };

      child.once("error", (error) => {
        finish(() => {
          reject(new HttpError(500, `${errorPrefix} ${toErrorMessage(error)}`));
        });
      });

      child.once("spawn", () => {
        finish(() => {
          child.unref();
          resolve(child.pid ?? null);
        });
      });
    });
  }

  private clientBaseDirectories(user: PortalUser): string[] {
    if (!env.clientBotRootDir) {
      return [];
    }

    return uniquePaths([
      path.join(env.clientBotRootDir, user.id),
      path.join(env.clientBotRootDir, sanitizeSegment(user.email)),
    ]);
  }

  private clientArchivePaths(user: PortalUser): string[] {
    if (!env.clientBotRootDir) {
      return [];
    }

    return uniquePaths([
      path.join(env.clientBotRootDir, `${user.id}.zip`),
      path.join(env.clientBotRootDir, `${sanitizeSegment(user.email)}.zip`),
    ]);
  }

  private async safeReadDirectory(directory: string) {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRecordError(error) && error.code === "ENOTDIR") {
        throw new HttpError(400, `Il percorso ${path.resolve(directory)} non e' una cartella valida del cliente.`);
      }

      if (isRecordError(error) && error.code === "EACCES") {
        throw new HttpError(403, `Non ho accesso alla cartella ${path.resolve(directory)} sul server.`);
      }

      throw error;
    }
  }

  private async ensureRunnableDirectory(directory: string): Promise<string> {
    const resolvedDirectory = path.resolve(directory);
    const packageJsonPath = path.join(resolvedDirectory, "package.json");

    if (!(await pathExists(resolvedDirectory))) {
      throw new HttpError(404, `La cartella ${resolvedDirectory} non esiste.`);
    }

    if (!(await pathExists(packageJsonPath))) {
      throw new HttpError(400, `Nella cartella ${resolvedDirectory} manca package.json, quindi npm start non puo' partire.`);
    }

    return resolvedDirectory;
  }

  private async openZipFile(zipPath: string): Promise<ZipFileHandle> {
    return new Promise<ZipFileHandle>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
        if (error || !zipFile) {
          reject(error ?? new Error(`Impossibile aprire ${zipPath}.`));
          return;
        }

        resolve(zipFile);
      });
    });
  }

  private async openZipEntryStream(zipFile: ZipFileHandle, entry: ZipEntryHandle): Promise<NodeJS.ReadableStream> {
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error(`Impossibile leggere ${entry.fileName}.`));
          return;
        }

        resolve(stream);
      });
    });
  }

  private async extractZipArchive(zipPath: string, targetDirectory: string): Promise<void> {
    const resolvedTarget = path.resolve(targetDirectory);
    await rm(resolvedTarget, { force: true, recursive: true });
    await mkdir(resolvedTarget, { recursive: true });

    const zipFile = await this.openZipFile(zipPath);

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const finishWithError = (error: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          try {
            zipFile.close();
          } catch {
            // no-op
          }
          reject(error);
        };

        const finishSuccessfully = () => {
          if (settled) {
            return;
          }

          settled = true;
          resolve();
        };

        zipFile.on("error", finishWithError);
        zipFile.on("end", finishSuccessfully);
        zipFile.on("entry", (entry) => {
          void (async () => {
            const relativeEntryPath = normalizeZipEntryPath(entry.fileName);
            if (!relativeEntryPath) {
              throw new HttpError(400, `Il pacchetto ${path.basename(zipPath)} contiene percorsi non validi.`);
            }

            const destinationPath = path.join(resolvedTarget, relativeEntryPath);
            if (!isPathInside(resolvedTarget, destinationPath)) {
              throw new HttpError(400, `Il pacchetto ${path.basename(zipPath)} contiene file fuori dalla cartella cliente.`);
            }

            if (entry.fileName.endsWith("/")) {
              await mkdir(destinationPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            await mkdir(path.dirname(destinationPath), { recursive: true });
            const entryStream = await this.openZipEntryStream(zipFile, entry);
            await pipeline(entryStream, createWriteStream(destinationPath));
            zipFile.readEntry();
          })().catch(finishWithError);
        });

        zipFile.readEntry();
      });
    } catch (error) {
      await rm(resolvedTarget, { force: true, recursive: true });
      throw error;
    }
  }

  private async findRunnableDirectories(baseDirectory: string, maxDepth = 2): Promise<string[]> {
    if (!(await pathExists(baseDirectory))) {
      return [];
    }

    const resolvedBaseDirectory = path.resolve(baseDirectory);
    const queue: Array<{ depth: number; directory: string }> = [{ depth: 0, directory: resolvedBaseDirectory }];
    const matches: string[] = [];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.directory)) {
        continue;
      }

      visited.add(current.directory);
      if (await pathExists(path.join(current.directory, "package.json"))) {
        matches.push(current.directory);
        continue;
      }

      if (current.depth >= maxDepth) {
        continue;
      }

      const entries = await this.safeReadDirectory(current.directory);
      for (const entry of entries) {
        if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
          continue;
        }

        queue.push({
          depth: current.depth + 1,
          directory: path.join(current.directory, entry.name),
        });
      }
    }

    return uniquePaths(matches);
  }

  private async materializeZipArchive(zipPath: string): Promise<string> {
    const resolvedZipPath = path.resolve(zipPath);
    if (!(await pathExists(resolvedZipPath))) {
      throw new HttpError(404, `Il pacchetto ${resolvedZipPath} non esiste.`);
    }

    const zipStats = await stat(resolvedZipPath);
    const deploymentDirectory = path.join(
      path.dirname(resolvedZipPath),
      deploymentCacheDirectoryName,
      `${sanitizeSegment(path.basename(resolvedZipPath, path.extname(resolvedZipPath)))}-${Math.trunc(zipStats.mtimeMs)}`,
    );

    let runnableDirectory = await this.findRunnableDirectory(deploymentDirectory).catch((error) => {
      if (error instanceof HttpError) {
        throw error;
      }

      return null;
    });
    if (!runnableDirectory) {
      await this.extractZipArchive(resolvedZipPath, deploymentDirectory);
      runnableDirectory = await this.findRunnableDirectories(deploymentDirectory, 3).then((directories) => {
        if (directories.length === 1) {
          return directories[0];
        }

        if (directories.length > 1) {
          throw new HttpError(
            400,
            `Il pacchetto ${path.basename(resolvedZipPath)} contiene piu' progetti npm. Tieni un solo bot dentro lo zip del cliente.`,
          );
        }

        return null;
      });
    }

    if (!runnableDirectory) {
      throw new HttpError(
        400,
        `Il pacchetto ${path.basename(resolvedZipPath)} non contiene un progetto avviabile con npm start.`,
      );
    }

    return runnableDirectory;
  }

  private async findRunnableDirectory(baseDirectory: string): Promise<string | null> {
    const resolvedBaseDirectory = path.resolve(baseDirectory);
    const matches = await this.findRunnableDirectories(resolvedBaseDirectory);
    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new HttpError(
        400,
        `La cartella cliente ${resolvedBaseDirectory} contiene piu' progetti npm. Lascia un solo bot pronto all'avvio.`,
      );
    }

    if (!(await pathExists(resolvedBaseDirectory))) {
      return null;
    }

    const entries = await this.safeReadDirectory(resolvedBaseDirectory);
    const zipCandidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
        .map(async (entry) => {
          const zipPath = path.join(resolvedBaseDirectory, entry.name);
          const zipStat = await stat(zipPath);
          return {
            mtimeMs: zipStat.mtimeMs,
            zipPath,
          };
        }),
    );

    if (zipCandidates.length === 0) {
      return null;
    }

    zipCandidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return this.materializeZipArchive(zipCandidates[0]!.zipPath);
  }

  private async resolveRunnableTarget(targetPath: string): Promise<string> {
    const resolvedTarget = path.resolve(targetPath);
    if (!(await pathExists(resolvedTarget))) {
      throw new HttpError(404, `La cartella o il pacchetto ${resolvedTarget} non esiste.`);
    }

    if (resolvedTarget.toLowerCase().endsWith(".zip")) {
      return this.materializeZipArchive(resolvedTarget);
    }

    const runnableDirectory = await this.findRunnableDirectory(resolvedTarget);
    if (runnableDirectory) {
      return runnableDirectory;
    }

    return this.ensureRunnableDirectory(resolvedTarget);
  }

  private async ensureAllowedManualDirectory(user: PortalUser, directory: string): Promise<string> {
    const resolvedDirectory = path.resolve(directory);

    if (!env.clientBotRootDir) {
      const workspaceRoot = await this.resolveLocalDefaultDirectory();
      if (!isPathInside(workspaceRoot, resolvedDirectory)) {
        throw new HttpError(
          403,
          `In locale puoi avviare solo cartelle dentro il workspace ${workspaceRoot}.`,
        );
      }

      return this.resolveRunnableTarget(resolvedDirectory);
    }

    const allowedBases = this.clientBaseDirectories(user);
    const isAllowed = allowedBases.some((baseDirectory) => isPathInside(baseDirectory, resolvedDirectory));
    if (!isAllowed) {
      throw new HttpError(
        403,
        "Puoi avviare solo la cartella assegnata al tuo account cliente sul server.",
      );
    }

    return this.resolveRunnableTarget(resolvedDirectory);
  }

  private async resolveDirectory(
    user: PortalUser,
    requestedDirectory?: string,
  ): Promise<ResolvedClientDirectory> {
    const manualDirectory = requestedDirectory?.trim();
    if (manualDirectory) {
      return {
        archivePath: null,
        directory: await this.ensureAllowedManualDirectory(user, manualDirectory),
        source: "manual",
      };
    }

    for (const candidate of this.clientBaseDirectories(user)) {
      const runnableDirectory = await this.findRunnableDirectory(candidate);
      if (runnableDirectory) {
        return {
          archivePath: null,
          directory: runnableDirectory,
          source: "server",
        };
      }
    }

    for (const archivePath of this.clientArchivePaths(user)) {
      if (!(await pathExists(archivePath))) {
        continue;
      }

      return {
        archivePath,
        directory: await this.materializeZipArchive(archivePath),
        source: "server",
      };
    }

    if (env.clientBotRootDir) {
      throw new HttpError(
        404,
        `Nessuna cartella valida trovata per il tuo account sotto ${env.clientBotRootDir}. Carica ed estrai il pacchetto del cliente nella cartella assegnata al suo utente.`,
      );
    }

    const localDefaultDirectory = await this.resolveLocalDefaultDirectory();
    return {
      archivePath: null,
      directory: await this.ensureRunnableDirectory(localDefaultDirectory),
      source: "local-default",
    };
  }

  async resolveLocalDefaultDirectory(): Promise<string> {
    const workspaceRoot = await findWorkspaceRoot(this.serviceDirectory);
    return workspaceRoot ?? process.cwd();
  }

  private async resolveLocalWorkerEntry(rootDirectory: string): Promise<string> {
    const entryPath = path.join(rootDirectory, "apps", "bot-worker", "dist", "server.js");
    if (!(await pathExists(entryPath))) {
      throw new HttpError(
        500,
        `Il worker locale non e' stato compilato: manca ${entryPath}. Esegui prima npm run build.`,
      );
    }

    return entryPath;
  }

  private async startInWindowsTerminal(directory: string): Promise<number | null> {
    // On Windows, detached cmd.exe gets its own console. Using cwd is more reliable
    // than composing a nested `start ... cd /d ... && npm start` command string.
    return this.startCommandInWindowsTerminal(directory, ["npm", "start"], `Impossibile aprire il terminale per ${directory}:`);
  }

  private async startWorkerInWindowsTerminal(directory: string): Promise<number | null> {
    return this.startCommandInWindowsTerminal(
      directory,
      ["npm", "run", "dev:bot-worker"],
      `Impossibile aprire il terminale del bot worker per ${directory}:`,
    );
  }

  private async startDetachedProcess(directory: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      const command = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(command, ["start"], {
        cwd: directory,
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: false,
      });

      let settled = false;
      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        handler();
      };

      child.once("error", (error) => {
        finish(() => {
          reject(new HttpError(500, `Impossibile eseguire npm start in ${directory}: ${toErrorMessage(error)}`));
        });
      });

      child.once("spawn", () => {
        finish(() => {
          child.unref();
          resolve(child.pid ?? null);
        });
      });
    });
  }

  private resolveNpmCliPath(): string {
    const npmExecPath = process.env.npm_execpath?.trim();
    if (npmExecPath) {
      return npmExecPath;
    }

    return path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  }

  private async startWindowsBackgroundNodeProcess(directory: string, args: string[], errorPrefix: string): Promise<number | null> {
    const npmCliPath = this.resolveNpmCliPath();
    const escapedNodePath = escapePowerShellSingleQuotedValue(process.execPath);
    const escapedDirectory = escapePowerShellSingleQuotedValue(directory);
    const escapedArgs = [npmCliPath, ...args]
      .map((value) => `'${escapePowerShellSingleQuotedValue(value)}'`)
      .join(", ");
    const command = [
      "$process = Start-Process",
      `-FilePath '${escapedNodePath}'`,
      `-ArgumentList @(${escapedArgs})`,
      `-WorkingDirectory '${escapedDirectory}'`,
      "-WindowStyle Hidden",
      "-PassThru;",
      "Write-Output $process.Id",
    ].join(" ");

    return new Promise<number | null>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
        cwd: directory,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.once("error", (error) => {
        reject(new HttpError(500, `${errorPrefix} ${toErrorMessage(error)}`));
      });

      child.once("close", (code) => {
        if (code !== 0) {
          const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
          reject(new HttpError(500, `${errorPrefix} ${details}`));
          return;
        }

        const pid = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(pid) ? pid : null);
      });
    });
  }

  private async startWorkerProcess(directory: string): Promise<number | null> {
    const entryPath = await this.resolveLocalWorkerEntry(directory);

    if (process.platform === "win32") {
      return this.startWindowsBackgroundNodeProcess(
        directory,
        [entryPath],
        `Impossibile avviare il bot worker in ${directory}:`,
      );
    }

    return new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [entryPath], {
        cwd: directory,
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      });

      let settled = false;
      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        handler();
      };

      child.once("error", (error) => {
        finish(() => {
          reject(new HttpError(500, `Impossibile avviare il bot worker in ${directory}: ${toErrorMessage(error)}`));
        });
      });

      child.once("spawn", () => {
        finish(() => {
          child.unref();
          resolve(child.pid ?? null);
        });
      });
    });
  }

  private async startTarget(
    directory: string,
    source: ResolvedClientDirectory["source"],
  ): Promise<StartTargetResult> {
    if (source === "local-default") {
      return {
        commandLabel: "node apps/bot-worker/dist/server.js",
        pid: await this.startWorkerProcess(directory),
        bootsWorker: true,
      };
    }

    if (process.platform === "win32") {
      return {
        commandLabel: "npm start",
        pid: await this.startInWindowsTerminal(directory),
        bootsWorker: false,
      };
    }

    return {
      commandLabel: "npm start",
      pid: await this.startDetachedProcess(directory),
      bootsWorker: false,
    };
  }

  async start(user: PortalUser, requestedDirectory?: string): Promise<StartClientBotResponse> {
    try {
      const { archivePath, directory, source } = await this.resolveDirectory(user, requestedDirectory);
      const { commandLabel, pid, bootsWorker } = await this.startTarget(directory, source);

      return {
        message:
          source === "manual"
            ? `Avvio richiesto con ${commandLabel} nella cartella selezionata ${directory}.`
            : source === "server"
              ? archivePath
                ? `Avvio richiesto con ${commandLabel} dal pacchetto cliente ${archivePath}, preparato automaticamente nella cartella ${directory}.`
                : `Avvio richiesto con ${commandLabel} nella cartella del cliente associata al tuo account: ${directory}.`
              : `Avvio richiesto con ${commandLabel} nella root locale ${directory}. Questo avvia solo il bot worker per QR, pairing e connessione reale WhatsApp.`,
        directory,
        pid,
        command: commandLabel,
        bootsWorker,
      };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(500, `Preparazione del bot cliente fallita: ${toErrorMessage(error)}`);
    }
  }
}
