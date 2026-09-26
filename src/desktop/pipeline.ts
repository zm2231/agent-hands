// Desktop execute pipeline (spec 01 section 5).

import { randomUUID } from "node:crypto";
import type { ToolResult, CallContext, ContentBlock } from "../kernel/types.js";
import { resolveAppIdentity } from "./os/identity.js";
import { acquireLock } from "./os/lock.js";
import { startFocusTelemetry } from "./os/focus.js";
import { normalizeKey } from "./os/key-normalize.js";
import { verifyBrokerComponents } from "./broker/verify.js";
import { brokerDispatch } from "./broker/dispatch.js";

import { sanitizeError } from "../kernel/sanitize.js";
import { trimAxTree, trimContentBlocks, SAVE_TO_TMP_THRESHOLD } from "./ax-trim.js";
import { DESKTOP_TOOLS } from "./tools.js";
import { validateArgs } from "../kernel/validate.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function executePipeline(
  method: string,
  args: Record<string, unknown>,
  ctx: CallContext
): Promise<ToolResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let outcome = "ok";
  let lock: { release(): Promise<void> } | null = null;
  let focusStop: (() => void) | null = null;
  let focusFinish: (() => Promise<import("./os/focus.js").FocusTelemetry>) | null = null;

  try {
    // Normalize press_key.
    if (method === "press_key" && typeof args.key === "string") {
      args = { ...args, key: normalizeKey(args.key) };
    }

    // Resolve app identity (list_apps has no app).
    let bundleId: string | null = null;
    let leaseId: string | null = null;

    if (method !== "list_apps") {
      const appStr = args.app as string;
      if (!appStr) {
        outcome = "identity_rejected";
        throw new Error("Missing app argument.");
      }
      const identity = await resolveAppIdentity(appStr);
      if (!identity.bundleId && method !== "list_apps") {
        outcome = "identity_rejected";
        throw new Error(
          `Cannot resolve app identity for "${appStr}". Provide a bundle identifier or full app path.`
        );
      }
      bundleId = identity.bundleId;
      leaseId = identity.leaseId;
      // Rewrite app to canonical bundle id.
      args = { ...args, app: bundleId };
    }

    // Acquire lock.
    if (leaseId) {
      lock = await acquireLock(leaseId, runId, args.app as string);
    }

    // Start focus telemetry.
    const focus = startFocusTelemetry(bundleId);
    focusStop = focus.stop;
    focusFinish = focus.finish;

    // Verify and dispatch through the broker.
    const components = await verifyBrokerComponents();

    const cleanArgs = { ...args };
    delete cleanArgs.screenshot;

    const isMutation = method !== "list_apps" && method !== "get_app_state";
    const result = await brokerDispatch(components, method, cleanArgs, {
      signal: ctx.signal,
      onElicitation: async (params) => {
        const resp = await ctx.elicit(params);
        return { action: resp.action };
      },
      requireActivationFor: isMutation ? bundleId ?? undefined : undefined,
      keepImages: args.screenshot === true,
    });

    // Assert zero-turn architecture.
    if (result.modelTurnsStarted !== 0 || !result.ephemeralThread) {
      outcome = "policy_violation";
      throw new Error("violated the zero-model-turn architecture");
    }

    outcome = result.isError ? "official_error" : "ok";

    // Finish focus telemetry (takes final sample after dispatch).
    const telemetry = await focusFinish!();

    await ctx.audit({
      timestamp: startedAt,
      runId,
      method,
      permissionMode: "no-permissions",
      app: bundleId ?? `target-sha256:${runId.slice(0, 16)}`,
      mutating: isMutation,
      outcome,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      brokerVersion: components.codexVersion,
      clientBuild: components.clientBuild,
      directCalls: result.directCalls,
      elicitationRequests: result.elicitationRequests,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      ephemeralRuntimeContext: true,
      brokerCleanupVerified: true,
      backgroundPreserved: telemetry.backgroundPreserved,
      unrelatedFocusChanges: telemetry.unrelatedFocusChanges,
    });

    let responseContent = result.content;

    // Trim large AX trees: cap element text values, save full to tmp if needed.
    const hasLargeText = responseContent.some(
      (b) => b.type === "text" && (b as any).text?.length > SAVE_TO_TMP_THRESHOLD
    );
    let tmpPath: string | undefined;
    if (hasLargeText) {
      try {
        const { mkdtemp: mkd } = await import("node:fs/promises");
        const dir = await mkd(join(tmpdir(), "agent-hands-ax-"), { mode: 0o700 } as any);
        tmpPath = join(dir, "tree.txt");
        const fullText = responseContent
          .filter((b) => b.type === "text")
          .map((b) => (b as any).text)
          .join("\n---\n");
        const { open: fsOpen } = await import("node:fs/promises");
        const fh = await fsOpen(tmpPath, "wx", 0o600);
        await fh.writeFile(fullText, "utf8");
        await fh.close();
      } catch { tmpPath = undefined; }
    }
    responseContent = trimContentBlocks(responseContent as any, tmpPath) as ContentBlock[];

    return { content: responseContent, isError: result.isError };
  } catch (e: unknown) {
    // Finish focus telemetry even on error (takes final sample).
    if (focusFinish) {
      try { await focusFinish(); } catch { /* telemetry failure non-fatal */ }
    } else {
      focusStop?.();
    }
    const msg = e instanceof Error ? e.message : String(e);

    // Audit the failure.
    try {
      await ctx.audit({
        timestamp: startedAt,
        runId,
        method,
        outcome,
        durationMs: Date.now() - new Date(startedAt).getTime(),
      });
    } catch {
      // Audit failure during error path is itself fatal.
      throw new Error(`Audit write failed during error handling: ${sanitizeError(msg)}`);
    }

    return {
      content: [{ type: "text", text: sanitizeError(msg) }],
      isError: true,
    };
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch {
        // Lock release failure after error is logged but not re-thrown.
      }
    }
  }
}


// --- Batch pipeline ---

interface BatchAction {
  method: string;
  [key: string]: unknown;
}

export async function executeBatchPipeline(
  app: string,
  actions: BatchAction[],
  continueOnError: boolean,
  ctx: CallContext
): Promise<ToolResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let outcome = "ok";
  let lock: { release(): Promise<void> } | null = null;
  let focusStop: (() => void) | null = null;
  let focusFinish: (() => Promise<import("./os/focus.js").FocusTelemetry>) | null = null;

  try {
    // Validate batch before acquiring any resources.
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error("Batch actions must be a non-empty array.");
    }
    if (actions.length > 20) {
      throw new Error(`Batch exceeds maximum of 20 actions (got ${actions.length}).`);
    }

    const batchable = new Map(
      DESKTOP_TOOLS.filter((t) => t.name !== "list_apps").map((t) => [t.name, t.inputSchema])
    );
    actions.forEach((a, i) => {
      if (!a.method || typeof a.method !== "string") {
        throw new Error("Each batch action must have a string 'method' field.");
      }
      const schema = batchable.get(a.method);
      if (!schema) {
        throw new Error(
          `Invalid batch method "${a.method}". ` +
          `Allowed: ${[...batchable.keys()].join(", ")}.`
        );
      }
      const { method: _method, ...actionArgs } = a;
      if ("app" in actionArgs) {
        throw new Error(`Batch action #${i + 1} (${a.method}): app is set once for the whole batch, not per action.`);
      }
      const err = validateArgs({ ...actionArgs, app }, schema);
      if (err) throw new Error(`Batch action #${i + 1} (${a.method}): ${err}`);
    });

    // Resolve app identity once for the whole batch.
    const identity = await resolveAppIdentity(app);
    if (!identity.bundleId) {
      outcome = "identity_rejected";
      throw new Error(
        `Cannot resolve app identity for "${app}". Provide a bundle identifier or full app path.`
      );
    }
    const bundleId = identity.bundleId;
    const leaseId = identity.leaseId;

    // Acquire lock once.
    if (leaseId) {
      lock = await acquireLock(leaseId, runId, app);
    }

    // Start focus telemetry once.
    const focus = startFocusTelemetry(bundleId);
    focusStop = focus.stop;
    focusFinish = focus.finish;

    const normalized = actions.map((a) => {
      const args: Record<string, unknown> = { ...a, app: bundleId };
      delete args.method;
      delete args.screenshot;
      if (a.method === "press_key" && typeof args.key === "string") {
        args.key = normalizeKey(args.key);
      }
      return { method: a.method, args, screenshot: a.screenshot === true };
    });

    const components = await verifyBrokerComponents();

    // The broker needs a get_app_state to establish CUA context; its output is not returned.
    const implicitActivation = normalized[0].method !== "get_app_state";
    if (implicitActivation) {
      normalized.unshift({ method: "get_app_state", args: { app: bundleId }, screenshot: normalized[0].screenshot });
    }
    const [primary, ...rest] = normalized;

    const result = await brokerDispatch(components, primary.method, primary.args, {
      signal: ctx.signal,
      followUpCalls: rest.map((r) => ({ tool: r.method, arguments: r.args, keepImages: r.screenshot })),
      continueOnError,
      keepImages: primary.screenshot,
    });

    // Assert zero-turn architecture.
    if (result.modelTurnsStarted !== 0 || !result.ephemeralThread) {
      outcome = "policy_violation";
      throw new Error("violated the zero-model-turn architecture");
    }

    const telemetry = await focusFinish!();

    const executed = [
      { ...primary, content: result.content, isError: result.isError },
      ...(result.followUpResults ?? []).map((fu, i) => ({ ...rest[i], content: fu.content, isError: fu.isError })),
    ];
    const anyError = executed.some((r) => r.isError);
    outcome = anyError ? "official_error" : "ok";

    await ctx.audit({
      timestamp: startedAt,
      runId,
      method: "desktop_batch",
      permissionMode: "no-permissions",
      app: bundleId,
      mutating: true,
      outcome,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      brokerVersion: components.codexVersion,
      clientBuild: components.clientBuild,
      directCalls: executed.length,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      ephemeralRuntimeContext: true,
      brokerCleanupVerified: true,
      backgroundPreserved: telemetry.backgroundPreserved,
      unrelatedFocusChanges: telemetry.unrelatedFocusChanges,
    });

    return { content: renderBatch(executed, implicitActivation, actions.length), isError: anyError };
  } catch (e: unknown) {
    if (focusFinish) {
      try { await focusFinish(); } catch { /* non-fatal */ }
    } else {
      focusStop?.();
    }
    const msg = e instanceof Error ? e.message : String(e);

    try {
      await ctx.audit({
        timestamp: startedAt,
        runId,
        method: "desktop_batch",
        outcome,
        durationMs: Date.now() - new Date(startedAt).getTime(),
      });
    } catch {
      throw new Error(`Audit write failed during error handling: ${sanitizeError(msg)}`);
    }

    return {
      content: [{ type: "text", text: sanitizeError(msg) }],
      isError: true,
    };
  } finally {
    if (lock) {
      try { await lock.release(); } catch { /* logged, not re-thrown */ }
    }
  }
}

const MAX_BATCH_RESPONSE_BYTES = 25 * 1024 * 1024 - 64 * 1024;

interface ExecutedAction {
  method: string;
  content: ContentBlock[];
  isError: boolean;
}

export function renderBatch(executed: ExecutedAction[], implicitActivation: boolean, requested: number): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let lines: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (lines.length) blocks.push({ type: "text", text: lines.join("\n") });
    lines = [];
  };
  const emit = (text: string, images: ContentBlock[]) => {
    const size = Buffer.byteLength(JSON.stringify(text), "utf8") +
      images.reduce((n, b) => n + Buffer.byteLength(JSON.stringify(b), "utf8"), 0);
    if (bytes + size > MAX_BATCH_RESPONSE_BYTES) return false;
    bytes += size;
    lines.push(text);
    if (images.length) {
      flush();
      blocks.push(...images);
    }
    return true;
  };

  executed.forEach((r, i) => {
    const step = implicitActivation ? i : i + 1;
    if (step === 0 && !r.isError) return;
    const label = step === 0 ? "activation" : `#${step} ${r.method}`;
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const images = r.content.filter((b) => b.type === "image");
    let fitted: boolean;
    if (r.isError) {
      fitted = emit(`${label}: error\n${text || "(no error text returned)"}`, images);
    } else if (r.method === "get_app_state") {
      fitted = emit(`${label}\n${trimAxTree(text).text}`, images);
    } else {
      fitted = emit(`${label}: ok`, images);
    }
    if (!fitted) lines.push(`${label}: ${r.isError ? "error, " : ""}output omitted (response size limit)`);
  });

  const ran = executed.length - (implicitActivation ? 1 : 0);
  if (ran < requested) lines.push(`stopped: ${ran} of ${requested} actions ran`);
  flush();
  return blocks;
}
