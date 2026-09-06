// Per-app filesystem lock using lockf(1).

import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

const uid = process.getuid?.() ?? 0;

function lockRoot(): string {
  return join(tmpdir(), `codex-computer-use-mcp-${uid}`);
}

async function ensureLockDir(): Promise<string> {
  const root = lockRoot();
  const locksDir = join(root, "locks");
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
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

function killChild(child: ChildProcess): void {
  try { child.stdin?.end(); } catch { /* ignore */ }
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

function awaitChildClose(child: ChildProcess, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error("Lock child did not exit within timeout; cleanup may be incomplete."));
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
        const ownerData = JSON.stringify({ runId, app, pid: process.pid, ts: new Date().toISOString() });
        writeFile(ownerPath, ownerData, { mode: 0o600 })
          .then(() => {
            resolved = true;
            resolve({
              async release() {
                // End stdin to release the kernel lock, then await child close.
                try { child.stdin!.end(); } catch { /* ignore */ }
                await awaitChildClose(child);
                // Remove owner if still ours.
                try {
                  const data = await readFile(ownerPath, "utf-8");
                  const parsed = JSON.parse(data);
                  if (parsed.runId === runId) await unlink(ownerPath);
                } catch { /* best effort */ }
              },
            });
          })
          .catch(async (err) => {
            // Owner write failed after lock acquired — kill and await child close to release the lock.
            killChild(child);
            try {
              await awaitChildClose(child);
            } catch (cleanupErr: unknown) {
              // Cleanup timeout — report both errors.
              const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              reject(new Error(`Lock owner write failed: ${err.message}; cleanup also failed: ${cleanupMsg}`));
              return;
            }
            reject(err);
          });
      }
    });

    let resolved = false;

    child.on("close", (code) => {
      if (!locked) {
        readFile(ownerPath, "utf-8")
          .then((data) => reject(new AppBusyError(app, data)))
          .catch(() => reject(new AppBusyError(app)));
      } else if (!resolved) {
        // Lock holder died before acquisition completed.
        reject(new Error("Lock holder process exited before acquisition completed."));
      }
    });

    child.on("error", (err) => {
      if (!locked) {
        reject(new AppBusyError(app));
      } else if (!resolved) {
        reject(new Error("Lock holder process errored before acquisition completed."));
      }
    });
  });
}
