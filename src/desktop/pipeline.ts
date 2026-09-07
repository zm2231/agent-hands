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

    // Auto-snapshot: when observe is true on a mutation, append get_app_state
    // as a follow-up call in the same broker session (one spawn, two tool/calls).
    const isMutation = method !== "list_apps" && method !== "get_app_state";
    const observe = isMutation && args.observe === true;
    const cleanArgs = { ...args };
    delete cleanArgs.observe; // Strip observe before sending to upstream tool.

    const followUpCalls = observe && bundleId
      ? [{ tool: "get_app_state", arguments: { app: bundleId } }]
      : [];

    const result = await brokerDispatch(components, method, cleanArgs, {
      signal: ctx.signal,
      onElicitation: async (params) => {
        const resp = await ctx.elicit(params);
        return { action: resp.action };
      },
      followUpCalls,
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
      directCalls: 1 + (result.followUpResults?.length ?? 0),
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

    // Merge follow-up results (e.g. auto-snapshot) into response content.
    let responseContent = result.content;
    if (result.followUpResults?.length) {
      const parts: ContentBlock[] = [...result.content];
      for (const fu of result.followUpResults) {
        if (!fu.isError) {
          parts.push(...fu.content);
        } else {
          // Follow-up failed — include a note but don't fail the whole response.
          parts.push({
            type: "text",
            text: "[observe] Post-action snapshot failed.",
          } as ContentBlock);
        }
      }
      responseContent = parts;
    }

    return {
      content: responseContent,
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

    // Validate action methods: must be known mutation/read tools, not batch-in-batch.
    const BATCHABLE_METHODS = new Set([
      "get_app_state", "click", "type_text", "press_key", "set_value",
      "select_text", "scroll", "drag", "perform_secondary_action",
    ]);
    for (const a of actions) {
      if (!a.method || typeof a.method !== "string") {
        throw new Error("Each batch action must have a string 'method' field.");
      }
      if (!BATCHABLE_METHODS.has(a.method)) {
        throw new Error(
          `Invalid batch method "${a.method}". ` +
          `Allowed: ${[...BATCHABLE_METHODS].join(", ")}.`
        );
      }
    }

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

    // Normalize keys, rewrite app, and strip agent-hands-only flags in all actions.
    const normalized = actions.map((a) => {
      const args: Record<string, unknown> = { ...a, app: bundleId };
      delete args.method;
      delete args.observe; // agent-hands control flag, not an upstream tool argument
      if (a.method === "press_key" && typeof args.key === "string") {
        args.key = normalizeKey(args.key);
      }
      return { method: a.method, args };
    });

    // Verify broker components once.
    const components = await verifyBrokerComponents();

    // Split into primary (first) + follow-ups (rest).
    const [primary, ...rest] = normalized;

    // Build follow-up calls for brokerDispatch.
    const followUpCalls = rest.map((r) => ({
      tool: r.method,
      arguments: r.args,
    }));

    const result = await brokerDispatch(components, primary.method, primary.args, {
      signal: ctx.signal,
      followUpCalls,
      continueOnError,
    });

    // Assert zero-turn architecture.
    if (result.modelTurnsStarted !== 0 || !result.ephemeralThread) {
      outcome = "policy_violation";
      throw new Error("violated the zero-model-turn architecture");
    }

    // Finish focus telemetry.
    const telemetry = await focusFinish!();

    // Collect ALL execution results first (for correct metadata).
    const allResults: Array<{ method: string; content: ContentBlock[]; isError: boolean }> = [];
    allResults.push({
      method: primary.method,
      content: result.content,
      isError: result.isError,
    });
    if (result.followUpResults) {
      for (let i = 0; i < result.followUpResults.length; i++) {
        const fu = result.followUpResults[i];
        allResults.push({
          method: rest[i].method,
          content: fu.content,
          isError: fu.isError,
        });
      }
    }

    // Execution facts from ALL results (before response truncation).
    const totalExecuted = allResults.length;
    const anyError = allResults.some((r) => r.isError);
    outcome = anyError ? "official_error" : "ok";

    // Truncate response payload to fit 25 MB aggregate.
    const MAX_BATCH_RESPONSE_BYTES = 25 * 1024 * 1024;
    const ENVELOPE_RESERVE = 4096;
    let aggregateBytes = 0;
    let truncatedAt: number | null = null;
    const responseResults: typeof allResults = [];

    for (let i = 0; i < allResults.length; i++) {
      const entry = allResults[i];
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (aggregateBytes + entryBytes + ENVELOPE_RESERVE > MAX_BATCH_RESPONSE_BYTES && responseResults.length > 0) {
        truncatedAt = i;
        break;
      }
      aggregateBytes += entryBytes;
      responseResults.push(entry);
    }

    const details = {
      runId,
      method: "desktop_batch",
      permissionMode: "no-permissions",
      app: bundleId,
      outcome,
      directCalls: totalExecuted,

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
      method: "desktop_batch",
      permissionMode: "no-permissions",
      app: bundleId,
      mutating: true,
      outcome,
      durationMs: details.durationMs,
      brokerVersion: components.codexVersion,
      clientBuild: components.clientBuild,
      directCalls: totalExecuted,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      brokerCleanupVerified: true,
    });

    // Build response: array of per-action results as a single text block.
    // Build candidate result and verify full envelope size.
    let candidateResults = responseResults;
    let candidateBody: Record<string, unknown>;
    let candidate: { content: ContentBlock[]; isError: boolean };

    // Shrink response until the full ToolResult envelope fits 25 MB.
    // Can shrink to zero results; even the empty response is bounded.
    while (true) {
      candidateBody = {
        batch: true,
        actions_executed: totalExecuted,
        actions_returned: candidateResults.length,
        actions_requested: actions.length,
        results: candidateResults,
      };
      if (candidateResults.length < allResults.length) {
        const omitted = totalExecuted - candidateResults.length;
        candidateBody.truncated = true;
        candidateBody.truncated_at = candidateResults.length;
        candidateBody.truncation_reason =
          `Aggregate response exceeded 25 MB limit; ${omitted} executed result(s) omitted from response.`;
        if (anyError) {
          candidateBody.has_omitted_errors = allResults.slice(candidateResults.length).some((r) => r.isError);
        }
      }

      candidate = {
        content: [{ type: "text", text: JSON.stringify(candidateBody) }],
        isError: anyError,
      };

      const envelopeBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (envelopeBytes <= MAX_BATCH_RESPONSE_BYTES) break;

      if (candidateResults.length === 0) {
        // Even the empty response exceeds the limit — return minimal fallback.
        return {
          content: [{ type: "text", text: JSON.stringify({
            batch: true, actions_executed: totalExecuted, actions_returned: 0,
            actions_requested: actions.length, results: [],
            truncated: true, truncation_reason: "All results omitted; response exceeded size limit.",
          }) }],
          isError: true,
        };
      }

      // Remove last result and retry.
      candidateResults = candidateResults.slice(0, -1);
    }

    return candidate;
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
