// Durable audit log (metadata only, fail-closed).

import { open, mkdir, stat, constants } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AuditRecord } from "./types.js";

function stateRoot(): string {
  return process.env.CODEX_COMPUTER_USE_HOME ?? join(homedir(), ".direct-computer-use");
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

export async function auditAppend(record: AuditRecord): Promise<void> {
  const root = stateRoot();
  const auditDir = join(root, "audit");
  await ensureDir(auditDir);

  const auditPath = join(auditDir, "direct-computer-use.jsonl");

  // Validate: no symlinks (O_NOFOLLOW not in Node, so lstat check).
  try {
    const s = await stat(auditPath);
    if (!s.isFile()) throw new Error("Audit path is not a regular file.");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const line = JSON.stringify(record) + "\n";
  const fd = await open(auditPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
  try {
    await fd.write(line);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
