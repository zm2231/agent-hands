// Per-app filesystem lock using lockf(1).

import { mkdir, writeFile, readFile, unlink, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const uid = process.getuid?.() ?? 0;

function lockRoot(): string {
  return join(tmpdir(), `codex-computer-use-mcp-${uid}`);
}

async function ensureLockDir(): Promise<string> {
  const root = lockRoot();
  const locksDir = join(root, "locks");
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  // Verify ownership.
  const s = await stat(root);
  if (!s.isDirectory()) throw new Error("Lock root is not a directory.");
  return locksDir;
}

function lockKey(leaseId: string): string {
  return createHash("sha256").update(leaseId).digest("hex");
}

export interface Lock {
  release(): Promise<void>;
}

export class AppBusyError extends Error {
  constructor(app: string, owner?: string) {
    const extra = owner ? ` Current owner: ${owner}` : "";
    super(
      `${app} is already leased by another direct Computer Use task; concurrent same-app access is blocked.${extra}`
    );
    this.name = "AppBusyError";
  }
}

export async function acquireLock(
  leaseId: string,
  runId: string,
  app: string
): Promise<Lock> {
  const locksDir = await ensureLockDir();
  const key = lockKey(leaseId);
  const lockPath = join(locksDir, `${key}.lock`);
  const ownerPath = join(locksDir, `${key}.owner.json`);

  return new Promise<Lock>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/lockf",
      ["-t", "0", lockPath, "/bin/sh", "-c", 'printf "LOCKED\\n"; /bin/cat >/dev/null'],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let locked = false;
    let stdout = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!locked && stdout.includes("LOCKED")) {
        locked = true;
        // Write owner file.
        const ownerData = JSON.stringify({ runId, app, pid: process.pid, ts: new Date().toISOString() });
        writeFile(ownerPath, ownerData, { mode: 0o600 })
          .then(() =>
            resolve({
              async release() {
                try {
                  child.stdin!.end();
                } catch {
                  // Already closed.
                }
                // Remove owner if still ours.
                try {
                  const data = await readFile(ownerPath, "utf-8");
                  const parsed = JSON.parse(data);
                  if (parsed.runId === runId) await unlink(ownerPath);
                } catch {
                  // Best effort.
                }
              },
            })
          )
          .catch(reject);
      }
    });

    child.on("close", (code) => {
      if (!locked) {
        // Could not acquire - read owner for diagnostics.
        readFile(ownerPath, "utf-8")
          .then((data) => reject(new AppBusyError(app, data)))
          .catch(() => reject(new AppBusyError(app)));
      }
    });

    child.on("error", (err) => {
      if (!locked) reject(new AppBusyError(app));
    });
  });
}
