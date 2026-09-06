// Screenshot and large-text artifact storage.

import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const TEXT_BUDGET_BYTES = 32_000;
const RESULT_TTL_MS = 3_600_000; // 1 hour
const SCREENSHOT_TTL_MS = 86_400_000; // 24 hours

let artifactDir: string | null = null;

async function ensureArtifactDir(): Promise<string> {
  if (artifactDir) return artifactDir;
  const base = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, "browser-tool")
    : join(tmpdir(), `browser-tool-${process.getuid?.() ?? 0}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  artifactDir = base;
  return base;
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
  const dir = await ensureArtifactDir();
  const filepath = join(dir, `result-${handle}.txt`);

  let text: string;
  try {
    text = await readFile(filepath, "utf-8");
  } catch {
    throw new Error(`Result handle not found: ${handle}. Re-run the original command.`);
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
