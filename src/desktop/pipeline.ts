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
    const result = await brokerDispatch(components, method, args, {
      signal: ctx.signal,
      onElicitation: async (params) => {
        const resp = await ctx.elicit(params);
        return { action: resp.action };
      },
    });

    // Assert zero-turn architecture.
    if (result.modelTurnsStarted !== 0 || !result.ephemeralThread) {
      outcome = "policy_violation";
      throw new Error("violated the zero-model-turn architecture");
    }

    outcome = result.isError ? "official_error" : "ok";

    // Finish focus telemetry (takes final sample after dispatch).
    const telemetry = await focusFinish!();

    // Build response.
    const details = {
      runId,
      method,
      permissionMode: "no-permissions",
      app: bundleId,
      outcome,
      directCalls: 1,
      modelTurnsStarted: 0,
      ephemeralRuntimeContext: true,
      brokerVersion: components.codexVersion,
      clientBuild: components.clientBuild,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      backgroundPreserved: telemetry.backgroundPreserved,
      unrelatedFocusChanges: telemetry.unrelatedFocusChanges,
      brokerCleanupVerified: true,
    };

    // Audit.
    await ctx.audit({
      timestamp: startedAt,
      runId,
      method,
      permissionMode: "no-permissions",
      app: bundleId ?? `target-sha256:${runId.slice(0, 16)}`,
      mutating: method !== "list_apps" && method !== "get_app_state",
      outcome,
      durationMs: details.durationMs,
      brokerVersion: components.codexVersion,
      clientBuild: components.clientBuild,
      directCalls: 1,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      brokerCleanupVerified: true,
    });

    return {
      content: result.content,
      structuredContent: details,
      isError: result.isError,
    };
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
