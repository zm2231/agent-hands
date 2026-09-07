// Browser Control surface: single "browser" action tool.

import type { SurfaceDescriptor, ToolDefinition, ToolResult, CallContext, SurfaceStatus, ContentBlock } from "../kernel/types.js";
import { discoverEndpoint } from "./cdp/discovery.js";
import { createCDPClient } from "./cdp/websocket.js";
import type { CDPClient } from "./cdp/types.js";
import { TabBridge } from "./tab-bridge.js";
import { takeSnapshot } from "./snapshot.js";
import { storeText, readResult, discardResult } from "./artifacts.js";
import {
  clickAction, typeAction, screenshotAction, navigateAction,
  evaluateAction, htmlAction, networkAction, rawAction,
  loadAllAction, helpAction,
} from "./actions/index.js";

const OUTPUT_BUDGET_BYTES = 38_000;
const MIN_TARGET_PREFIX_LENGTH = 8;
const HANDLE_RE = /^[a-f0-9-]{36}$/;

const VALID_ACTIONS = new Set([
  "help", "start", "tabs", "open", "find", "click", "type",
  "screenshot", "html", "navigate", "evaluate", "network",
  "load_all", "raw", "read_result", "discard_result", "stop",
]);

const ACTION_FIELDS: Record<string, Set<string>> = {
  help: new Set([]),
  start: new Set([]),
  tabs: new Set(["query", "offset"]),
  open: new Set(["ref_id", "url", "lineno", "response_length"]),
  find: new Set(["ref_id", "pattern", "lineno", "response_length"]),
  click: new Set(["ref_id", "id", "selector", "x", "y"]),
  type: new Set(["ref_id", "id", "text"]),
  screenshot: new Set(["ref_id", "id", "selector"]),
  html: new Set(["ref_id", "id", "selector"]),
  navigate: new Set(["ref_id", "url"]),
  evaluate: new Set(["ref_id", "expression"]),
  network: new Set(["ref_id"]),
  load_all: new Set(["ref_id", "selector", "interval_ms"]),
  raw: new Set(["ref_id", "method", "params"]),
  read_result: new Set(["handle", "offset"]),
  discard_result: new Set(["handle"]),
  stop: new Set(["ref_id"]),
};

// Session state.
let rootCDP: CDPClient | null = null;
const bridges = new Map<string, TabBridge>(); // targetId -> TabBridge

async function ensureRoot(): Promise<CDPClient> {
  if (rootCDP) return rootCDP;
  const wsUrl = await discoverEndpoint();
  rootCDP = await createCDPClient(wsUrl);
  rootCDP.on("close", () => {
    rootCDP = null;
    // Close all stale bridges on root disconnect.
    for (const b of bridges.values()) b.close();
    bridges.clear();
  });
  return rootCDP;
}

async function getPages(cdp: CDPClient): Promise<Array<{ targetId: string; title: string; url: string }>> {
  const result = await cdp.send("Target.getTargets");
  const targets = (result.targetInfos as any[]) ?? [];
  return targets
    .filter((t: any) => t.type === "page" && !t.url?.startsWith("chrome://"))
    .map((t: any) => ({ targetId: t.targetId, title: t.title ?? "", url: t.url ?? "" }));
}

function computeRefId(targetId: string, allTargetIds: string[]): string {
  let len = MIN_TARGET_PREFIX_LENGTH;
  while (len < targetId.length) {
    const prefix = targetId.slice(0, len);
    if (allTargetIds.filter((id) => id.startsWith(prefix)).length === 1) break;
    len++;
  }
  return targetId.slice(0, len);
}

function resolveTargetId(refId: string, pages: Array<{ targetId: string }>): string {
  const matches = pages.filter((p) => p.targetId.startsWith(refId));
  if (matches.length === 0) throw new Error(`No target matching prefix ${refId}. Call tabs to see open tabs.`);
  if (matches.length > 1) throw new Error(`Ambiguous prefix ${refId}. Use more characters.`);
  return matches[0].targetId;
}

const bridgeInflight = new Map<string, Promise<TabBridge>>();

async function ensureBridge(cdp: CDPClient, targetId: string): Promise<TabBridge> {
  const existing = bridges.get(targetId);
  if (existing && !existing.isClosed) {
    existing.resetIdle();
    return existing;
  }

  // If there's an in-flight creation for this target, wait for it.
  const inflight = bridgeInflight.get(targetId);
  if (inflight) return inflight;

  const creating = (async () => {
    const result = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = result.sessionId as string;

    const bridge = new TabBridge(targetId, sessionId, cdp, () => {
      // Only delete if this bridge is still the current one.
      if (bridges.get(targetId) === bridge) {
        bridges.delete(targetId);
      }
    });

    const destroyHandler = (params: Record<string, unknown>) => {
      if (params.targetId === targetId) {
        bridge.close();
      }
    };
    cdp.on("Target.targetDestroyed", destroyHandler);

    const detachHandler = (params: Record<string, unknown>, sid?: string) => {
      if (sid === sessionId || params.sessionId === sessionId) {
        bridge.close();
      }
    };
    cdp.on("Target.detachedFromTarget", detachHandler);

    // Register listener removal so close() cleans up regardless of reason.
    bridge.addCleanup(() => {
      cdp.off("Target.targetDestroyed", destroyHandler);
      cdp.off("Target.detachedFromTarget", detachHandler);
    });

    bridges.set(targetId, bridge);
    return bridge;
  })();

  bridgeInflight.set(targetId, creating);
  try {
    return await creating;
  } finally {
    bridgeInflight.delete(targetId);
  }
}

function validateAction(args: Record<string, unknown>): { action: string; fields: Record<string, unknown> } {
  const action = args.action as string;
  if (!action || !VALID_ACTIONS.has(action)) {
    throw new Error(`Unknown action: ${action}. Valid: ${[...VALID_ACTIONS].join(", ")}`);
  }
  const allowed = ACTION_FIELDS[action]!;
  const fields: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "action") continue;
    if (!allowed.has(k)) {
      unknown.push(k);
    } else {
      fields[k] = v;
    }
  }
  if (unknown.length > 0) {
    throw new Error(`unknown ${action} field(s): ${unknown.join(", ")}`);
  }
  return { action, fields };
}

function requireRefId(fields: Record<string, unknown>, action: string): string {
  const refId = fields.ref_id;
  if (typeof refId !== "string" || !refId) {
    throw new Error(`${action} requires a ref_id returned by tabs; call tabs first.`);
  }
  return refId;
}

async function handleSingleAction(
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { action, fields } = validateAction(args);

  // Actions that don't need CDP / ref_id.
  if (action === "help") return helpAction();

  if (action === "read_result") {
    const handle = fields.handle as string;
    if (!handle || !HANDLE_RE.test(handle)) throw new Error("handle must be a UUID.");
    const offset = (fields.offset as number) ?? 0;
    return readResult(handle, offset);
  }

  if (action === "discard_result") {
    const handle = fields.handle as string;
    if (!handle || !HANDLE_RE.test(handle)) throw new Error("handle must be a UUID.");
    await discardResult(handle);
    return { result: "ok" };
  }

  if (action === "start") {
    try {
      await ensureRoot();
      return { result: "Browser already attached." };
    } catch (e: unknown) {
      throw new Error(
        "Automatic browser launch requires a Linux systemd session. " +
          "Start your browser with --remote-debugging-port=9222."
      );
    }
  }

  // All remaining actions need CDP.
  const cdp = await ensureRoot();

  if (action === "tabs") {
    const pages = await getPages(cdp);
    const allIds = pages.map((p) => p.targetId);
    const query = fields.query as string | undefined;
    let filtered = pages;
    if (query) {
      const lower = query.toLowerCase();
      filtered = pages.filter(
        (p) => p.title.toLowerCase().includes(lower) || p.url.toLowerCase().includes(lower)
      );
    }
    const rawOffset = (fields.offset as number) ?? 0;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
    const tabs = filtered.slice(offset).map((p) => ({
      ref_id: computeRefId(p.targetId, allIds),
      title: p.title.slice(0, 500),
      url: p.url.slice(0, 8000),
    }));

    const result: Record<string, unknown> = { offset, tabs };
    // Byte budget.
    let serialized = JSON.stringify(result);
    while (Buffer.byteLength(serialized, "utf8") > OUTPUT_BUDGET_BYTES && (result.tabs as any[]).length > 0) {
      (result.tabs as any[]).pop();
      result.truncated = true;
      result.omitted_tabs = filtered.length - offset - (result.tabs as any[]).length;
      result.next_offset = offset + (result.tabs as any[]).length;
      serialized = JSON.stringify(result);
    }
    return result;
  }

  if (action === "stop") {
    const refId = fields.ref_id as string | undefined;
    if (refId) {
      const pages = await getPages(cdp);
      const targetId = resolveTargetId(refId, pages);
      const bridge = bridges.get(targetId);
      if (bridge) bridge.close();
      return { ref_id: refId, result: "Tab bridge closed." };
    }
    for (const b of bridges.values()) b.close();
    bridges.clear();
    return { result: "All tab bridges closed." };
  }

  // Tab-scoped actions.
  const pages = await getPages(cdp);
  const allIds = pages.map((p) => p.targetId);

  if (action === "open" && fields.url && !fields.ref_id) {
    // Open new tab.
    const url = fields.url as string;
    const result = await cdp.send("Target.createTarget", { url });
    const targetId = result.targetId as string;
    const refId = computeRefId(targetId, [...allIds, targetId]);
    const bridge = await ensureBridge(cdp, targetId);

    return bridge.enqueue(async () => {
      // Wait for load.
      await new Promise((r) => setTimeout(r, 1000));
      const snapshot = await takeSnapshot(cdp, bridge.sessionId, refId, bridge.elementRefs, {
        lineno: fields.lineno as number | undefined,
        responseLength: fields.response_length as string | undefined,
      });
      return snapshot as unknown as Record<string, unknown>;
    });
  }

  const refId = requireRefId(fields, action);
  const targetId = resolveTargetId(refId, pages);
  const computedRefId = computeRefId(targetId, allIds);
  const bridge = await ensureBridge(cdp, targetId);

  return bridge.enqueue(async () => {
    if (signal?.aborted) throw new Error("Request aborted.");
    switch (action) {
      case "open": {
        const snapshot = await takeSnapshot(cdp, bridge.sessionId, computedRefId, bridge.elementRefs, {
          lineno: fields.lineno as number | undefined,
          responseLength: fields.response_length as string | undefined,
        });
        return snapshot as unknown as Record<string, unknown>;
      }
      case "find": {
        const snapshot = await takeSnapshot(cdp, bridge.sessionId, computedRefId, bridge.elementRefs, {
          pattern: fields.pattern as string,
          lineno: fields.lineno as number | undefined,
          responseLength: fields.response_length as string | undefined,
        });
        return snapshot as unknown as Record<string, unknown>;
      }
      case "click": {
        const result = await clickAction(cdp, bridge.sessionId, bridge.elementRefs, fields);
        return { ref_id: computedRefId, result };
      }
      case "type": {
        if (typeof fields.text !== "string" || !fields.text) throw new Error("type requires non-empty text.");
        const result = await typeAction(cdp, bridge.sessionId, bridge.elementRefs, fields);
        return { ref_id: computedRefId, result };
      }
      case "screenshot": {
        return screenshotAction(cdp, bridge.sessionId, bridge.elementRefs, computedRefId, fields);
      }
      case "html": {
        const raw = await htmlAction(cdp, bridge.sessionId, bridge.elementRefs, fields);
        const stored = await storeText(raw);
        const result: Record<string, unknown> = { ref_id: computedRefId, html: stored.inline };
        if (stored.truncated) {
          result.truncated = true;
          result.omitted_chars = stored.omittedChars;
          result.result_handle = stored.handle;
          result.next_offset = stored.nextOffset;
        }
        return result;
      }
      case "navigate": {
        const result = await navigateAction(cdp, bridge.sessionId, fields, signal);
        return { ref_id: computedRefId, result };
      }
      case "evaluate": {
        const raw = await evaluateAction(cdp, bridge.sessionId, fields);
        const stored = await storeText(raw);
        const result: Record<string, unknown> = { ref_id: computedRefId, value: stored.inline };
        if (stored.truncated) {
          result.truncated = true;
          result.omitted_chars = stored.omittedChars;
          result.result_handle = stored.handle;
          result.next_offset = stored.nextOffset;
        }
        return result;
      }
      case "network": {
        const raw = await networkAction(cdp, bridge.sessionId);
        const stored = await storeText(raw);
        const result: Record<string, unknown> = { ref_id: computedRefId, network: stored.inline };
        if (stored.truncated) {
          result.truncated = true;
          result.omitted_chars = stored.omittedChars;
          result.result_handle = stored.handle;
          result.next_offset = stored.nextOffset;
        }
        return result;
      }
      case "raw": {
        const raw = await rawAction(cdp, bridge.sessionId, fields);
        const stored = await storeText(raw);
        const result: Record<string, unknown> = { ref_id: computedRefId, raw: stored.inline };
        if (stored.truncated) {
          result.truncated = true;
          result.omitted_chars = stored.omittedChars;
          result.result_handle = stored.handle;
          result.next_offset = stored.nextOffset;
        }
        return result;
      }
      case "load_all": {
        if (typeof fields.selector !== "string" || !fields.selector) throw new Error("load_all requires a selector.");
        const result = await loadAllAction(cdp, bridge.sessionId, fields, signal);
        return { ref_id: computedRefId, result };
      }
      default:
        throw new Error(`Unhandled action: ${action}`);
    }
  });
}

export function createBrowserSurface(): SurfaceDescriptor {
  const browserTool: ToolDefinition = {
    name: "browser",
    description:
      "Control the user's Chrome browser. Send a JSON object with an \"action\" field. " +
      "Call help for the full action list. Call tabs to see open tabs and get ref_ids.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        ref_id: { type: "string" },
        url: { type: "string" },
        query: { type: "string" },
        pattern: { type: "string" },
        id: { type: "integer" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        expression: { type: "string" },
        method: { type: "string" },
        params: { type: "object" },
        handle: { type: "string" },
        offset: { type: "integer" },
        lineno: { type: "integer" },
        response_length: { type: "string", enum: ["short", "medium", "long"] },
        interval_ms: { type: "integer" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };

  return {
    name: "browser",
    tools: [browserTool],

    isAvailable() {
      return true; // Browser need not be attachable yet; start/discovery handle it.
    },

    async handle(
      _toolName: string,
      args: Record<string, unknown>,
      ctx: CallContext
    ): Promise<ToolResult> {
      try {
        const result = await handleSingleAction(args, ctx.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }
    },

    status() {
      return {
        attached: rootCDP != null,
        activeBridges: bridges.size,
      };
    },
  };
}
