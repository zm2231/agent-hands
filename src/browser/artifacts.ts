// Screenshot and large-text artifact storage.

import { mkdir, writeFile, readFile, unlink, stat, lstat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const TEXT_BUDGET_BYTES = 32_000;
const RESULT_TTL_MS = 3_600_000; // 1 hour
const SCREENSHOT_TTL_MS = 86_400_000; // 24 hours

const HANDLE_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function assertHandle(h: string): void {
  if (!HANDLE_RE.test(h)) throw new Error("Invalid result handle.");
}

let artifactDir: string | null = null;
let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

async function ensureArtifactDir(): Promise<string> {
  if (artifactDir) return artifactDir;

  let base: string;
  if (process.env.XDG_RUNTIME_DIR) {
    base = join(process.env.XDG_RUNTIME_DIR, "browser-tool");
    await mkdir(base, { recursive: true, mode: 0o700 });
  } else {
    // Use mkdtemp for a unique, unpredictable directory under tmpdir.
    const { mkdtemp: mkdtempAsync } = await import("node:fs/promises");
    base = await mkdtempAsync(join(tmpdir(), "browser-tool-"));
    await chmod(base, 0o700);
  }

  // Validate: must be a non-symlink directory owned by us with no group/other bits.
  const s = await lstat(base);
  if (!s.isDirectory()) throw new Error("Artifact directory is not a directory.");
  if (s.isSymbolicLink()) throw new Error("Artifact directory is a symlink.");
  const uid = process.getuid?.();
  if (uid != null && s.uid !== uid) {
    throw new Error("Artifact directory not owned by current user.");
  }
  const mode = s.mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`Artifact directory has group/other permissions (${mode.toString(8)}).`);
  }

  artifactDir = base;
  return base;
}

async function sweepExpired(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  const dir = artifactDir;
  if (!dir) return;

  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    for (const file of files) {
      const filepath = join(dir, file);
      try {
        const s = await stat(filepath);
        const age = now - s.mtimeMs;
        if (file.endsWith(".png") && age > SCREENSHOT_TTL_MS) {
          await unlink(filepath).catch(() => {});
        } else if (file.startsWith("result-") && file.endsWith(".txt") && age > RESULT_TTL_MS) {
          await unlink(filepath).catch(() => {});
        }
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
}

function safeRef(refId: string): string {
  return refId.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "_");
}

export async function saveScreenshot(
  data: Buffer,
  refId: string,
  elementId?: number
): Promise<string> {
  const dir = await ensureArtifactDir();
  sweepExpired().catch(() => {}); // Non-blocking cleanup.
  const parts = ["browser", safeRef(refId)];
  if (elementId != null) parts.push("element", String(elementId));
  parts.push(randomUUID());
  const filename = parts.join("-") + ".png";
  const filepath = join(dir, filename);
  await writeFile(filepath, data, { mode: 0o600 });
  return filepath;
}

export interface TextResult {
  inline: string;
  truncated: boolean;
  omittedChars?: number;
  handle?: string;
  nextOffset?: number;
}

export async function storeText(text: string): Promise<TextResult> {
  sweepExpired().catch(() => {}); // Non-blocking cleanup.
  const encoded = Buffer.from(JSON.stringify(text));
  if (encoded.length <= TEXT_BUDGET_BYTES) {
    return { inline: text, truncated: false };
  }
  // Store full text and return a handle.
  const dir = await ensureArtifactDir();
  const handle = randomUUID();
  const filepath = join(dir, `result-${handle}.txt`);
  await writeFile(filepath, text, { mode: 0o600 });

  // Return first chunk.
  const chunkEnd = findJsonSafeCut(text, TEXT_BUDGET_BYTES);
  return {
    inline: text.slice(0, chunkEnd),
    truncated: true,
    omittedChars: text.length - chunkEnd,
    handle,
    nextOffset: chunkEnd,
  };
}

export async function readResult(
  handle: string,
  offset: number = 0
): Promise<{ handle: string; offset: number; text: string; complete: boolean; next_offset?: number }> {
  assertHandle(handle);
  const dir = await ensureArtifactDir();
  const filepath = join(dir, `result-${handle}.txt`);

  let text: string;
  try {
    text = await readFile(filepath, "utf-8");
  } catch {
    throw new Error(`Result handle not found: ${handle}. Re-run the original command.`);
  }

  // Enforce TTL at read time.
  try {
    const s = await stat(filepath);
    if (Date.now() - s.mtimeMs > RESULT_TTL_MS) {
      await unlink(filepath).catch(() => {});
      throw new Error(`Result handle expired: ${handle}. Re-run the original command.`);
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("expired")) throw e;
    // stat failure is non-fatal for read.
  }

  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new Error("offset must be a non-negative integer.");
  }
  const remaining = text.slice(offset);
  const chunkEnd = findJsonSafeCut(remaining, TEXT_BUDGET_BYTES);
  const chunk = remaining.slice(0, chunkEnd);
  const complete = offset + chunkEnd >= text.length;

  if (complete) {
    await unlink(filepath).catch(() => {});
  }

  return {
    handle,
    offset,
    text: chunk,
    complete,
    ...(complete ? {} : { next_offset: offset + chunkEnd }),
  };
}

export async function discardResult(handle: string): Promise<void> {
  assertHandle(handle);
  const dir = await ensureArtifactDir();
  const filepath = join(dir, `result-${handle}.txt`);
  await unlink(filepath).catch(() => {});
}

function findJsonSafeCut(text: string, budget: number): number {
  if (Buffer.from(JSON.stringify(text.slice(0, budget))).length <= budget) {
    return Math.min(budget, text.length);
  }
  // Binary search for the right cut point.
  let lo = 0;
  let hi = Math.min(budget, text.length);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (Buffer.from(JSON.stringify(text.slice(0, mid))).length <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
