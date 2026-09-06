// Durable audit log (metadata only, fail-closed).

import { open, mkdir, lstat, constants } from "node:fs/promises";
import { join } from "node:path";
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
  // Verify: must be a directory, not a symlink, owned by us.
  const s = await lstat(dir);
  if (!s.isDirectory()) throw new Error(`Audit directory is not a directory: ${dir}`);
  if (s.isSymbolicLink()) throw new Error(`Audit directory is a symlink: ${dir}`);
  const uid = process.getuid?.();
  if (uid != null && s.uid !== uid) {
    throw new Error(`Audit directory not owned by current user: ${dir}`);
  }
  const mode = s.mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`Audit directory has group/other permissions (${mode.toString(8)}): ${dir}`);
  }
}

export async function auditAppend(record: AuditRecord): Promise<void> {
  const root = stateRoot();
  await ensureDir(root);
  const auditDir = join(root, "audit");
  await ensureDir(auditDir);

  const auditPath = join(auditDir, "direct-computer-use.jsonl");

  const line = JSON.stringify(record) + "\n";
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
  const fd = await open(auditPath, flags, 0o600);
  try {
    // Validate the opened descriptor: must be regular file, owned by us, no group/other.
    const fdStat = await fd.stat();
    if (!fdStat.isFile()) throw new Error("Audit fd is not a regular file.");
    const uid = process.getuid?.();
    if (uid != null && fdStat.uid !== uid) {
      throw new Error("Audit file not owned by current user.");
    }
    const fileMode = fdStat.mode & 0o777;
    if (fileMode & 0o077) {
      throw new Error(`Audit file has group/other permissions (${fileMode.toString(8)}).`);
    }
    await fd.write(line);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
