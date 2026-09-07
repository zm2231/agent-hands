// Broker: authenticated zero-turn dispatch through the signed codex app-server.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { BrokerComponents } from "./verify.js";
import type { ContentBlock } from "../../kernel/types.js";

const MAX_LINE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_RESULT_BYTES = 25 * 1024 * 1024; // 25 MB

interface JsonRpcRequest {
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface FollowUpCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface BrokerResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  modelTurnsStarted: number;
  ephemeralThread: boolean;
  followUpResults?: BrokerResult[];
}

export async function brokerDispatch(
  components: BrokerComponents,
  method: string,
  args: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    toolTimeoutMs?: number;
    supportsElicitation?: boolean;
    onElicitation?: (
      params: Record<string, unknown>
    ) => Promise<{ action: string }>;
    followUpCalls?: FollowUpCall[];
  } = {}
): Promise<BrokerResult> {
  const toolTimeout = options.toolTimeoutMs ?? 120_000;
  let modelTurnsStarted = 0;

  // Create isolated temp tree.
  const tempRoot = await mkdtemp(join(tmpdir(), "direct-computer-use."));
  const codexHome = join(tempRoot, "codex-home");
  const workDir = join(tempRoot, "work");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), "", { mode: 0o600 });
  await mkdir(workDir, { mode: 0o700 });

  let proc: ChildProcess | null = null;

  try {
    // Build environment.
    const env: Record<string, string> = {
      HOME: tempRoot,
      CODEX_HOME: codexHome,
      TMPDIR: tempRoot,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NO_COLOR: "1",
      CLICOLOR: "0",
    };
    for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    // Build config overrides as -c args.
    const configArgs = [
      "-c", 'model_provider="direct_disabled"',
      "-c", 'model="direct-disabled"',
      "-c", 'model_providers.direct_disabled={ name = "Direct dispatch disabled provider", base_url = "http://127.0.0.1:9/v1", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0, supports_websockets = false, requires_openai_auth = false }',
      "-c", "features.shell_tool=false",
      "-c", "features.unified_exec=false",
      "-c", "features.multi_agent=false",
      "-c", "features.memories=false",
      "-c", "memories.use_memories=false",
      "-c", "memories.generate_memories=false",
      "-c", "features.remote_plugin=false",
      "-c", "features.plugins=false",
      "-c", "features.remote_control=false",
      "-c", "features.hooks=false",
      "-c", "analytics.enabled=false",
      "-c", 'otel.exporter="none"',
      "-c", 'web_search="disabled"',
      "-c", 'history.persistence="none"',
      "-c", `mcp_servers={"computer-use" = { command = "${components.clientPath}", args = ["mcp"], cwd = "${workDir}", enabled = true, startup_timeout_sec = 30, tool_timeout_sec = 120 }}`,
      "-c", "plugins={}",
    ];

    proc = spawn(components.codexPath, [...configArgs, "app-server", "--stdio"], {
      cwd: workDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });

    const reader = createLineReader(proc);

    // Helper to send JSON-RPC.
    let nextId = 1;
    function send(msg: JsonRpcRequest | JsonRpcNotification) {
      proc!.stdin!.write(JSON.stringify(msg) + "\n");
    }

    async function request(
      reqMethod: string,
      params: Record<string, unknown>,
      timeoutMs: number
    ): Promise<Record<string, unknown>> {
      const id = nextId++;
      send({ method: reqMethod, id, params });
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const line = await reader.next(Math.max(deadline - Date.now(), 100));
        const msg = JSON.parse(line);
        // Check for model turn activity.
        if (msg.method && (msg.method.startsWith("turn/") || msg.method.startsWith("item/"))) {
          modelTurnsStarted++;
          throw new Error("Model turn detected: violated the zero-model-turn architecture.");
        }
        // Handle server-initiated requests (elicitation).
        if (msg.method === "mcpServer/elicitation/request" && msg.id != null) {
          let action = "cancel";
          if (options.onElicitation) {
            try {
              const result = await options.onElicitation(msg.params ?? {});
              if (["accept", "decline", "cancel"].includes(result.action)) {
                action = result.action;
              }
            } catch {
              action = "cancel";
            }
          }
          send({ method: msg.method, id: msg.id, params: { action } } as any);
          continue;
        }
        // Handle unsupported server requests.
        if (msg.method && msg.id != null) {
          send({
            method: msg.method,
            id: msg.id,
            params: { error: { code: -32601, message: "Unsupported server request" } },
          } as any);
          continue;
        }
        // Match our response.
        if (msg.id === id) {
          if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
          return msg.result ?? {};
        }
      }
    }

    // Wire abort signal to kill the process.
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        if (proc && !proc.killed) {
          try {
            if (proc.pid) process.kill(-proc.pid, "SIGKILL");
          } catch {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        }
      }, { once: true });
    }

    // 1. initialize
    await request("initialize", {
      clientInfo: { name: "agent-hands", title: "agent-hands", version: "0.1.0" },
      capabilities: { mcpServerOpenaiFormElicitation: options.supportsElicitation ?? false },
    }, 15_000);

    // 2. initialized notification
    send({ method: "initialized" });

    // 3. thread/start
    const threadResult = await request("thread/start", {
      cwd: workDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      serviceName: "agent-hands",
    }, 30_000);

    const thread = threadResult.thread as any;
    if (
      typeof thread?.id !== "string" ||
      thread.ephemeral !== true ||
      thread.path !== null ||
      !Array.isArray(thread.turns) ||
      thread.turns.length !== 0
    ) {
      throw new Error(
        "App-server did not attest an empty pathless ephemeral runtime context."
      );
    }

    const threadId = thread.id;

    // 4a. mcpServerStatus/list (verify inventory)
    const inventoryResult = await request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
    }, 45_000);

    // Validate the inventory: must contain computer-use server with expected tools.
    const inventoryData = (inventoryResult.data ?? inventoryResult.servers ?? []) as any[];
    const cuServer = inventoryData.find((s: any) => s.name === "computer-use");
    if (!cuServer) {
      throw new Error("Inventory missing computer-use server.");
    }
    const expectedMethods = [
      "click", "drag", "get_app_state", "list_apps", "perform_secondary_action",
      "press_key", "scroll", "select_text", "set_value", "type_text",
    ];
    if (!cuServer.tools || typeof cuServer.tools !== "object") {
      throw new Error("Inventory computer-use server exposed no tool table.");
    }
    const toolNames = Object.keys(cuServer.tools as Record<string, unknown>).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(expectedMethods)) {
      throw new Error(
        `Inventory tool mismatch. Expected: ${expectedMethods.join(",")}; got: ${toolNames.join(",")}`
      );
    }

    // 4b. mcpServer/tool/call (primary)
    const callResult = await request("mcpServer/tool/call", {
      threadId,
      server: "computer-use",
      tool: method,
      arguments: args,
    }, toolTimeout);

    // Assert zero model turns after primary call.
    if (modelTurnsStarted > 0) {
      throw new Error("violated the zero-model-turn architecture");
    }

    // Validate primary result.
    const content = (callResult.content ?? []) as ContentBlock[];
    const isError = Boolean(callResult.isError);

    // Size check on primary.
    const serialized = JSON.stringify({ content, structuredContent: callResult });
    if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
      throw new Error("Result exceeds 25 MB limit.");
    }

    // 4c. Follow-up calls (same session, sequential, each zero-turn checked).
    const followUpResults: BrokerResult[] = [];
    if (!isError && options.followUpCalls?.length) {
      for (const followUp of options.followUpCalls) {
        const turnsBeforeFollowUp = modelTurnsStarted;
        const fuResult = await request("mcpServer/tool/call", {
          threadId,
          server: "computer-use",
          tool: followUp.tool,
          arguments: followUp.arguments,
        }, toolTimeout);

        if (modelTurnsStarted > turnsBeforeFollowUp) {
          throw new Error("violated the zero-model-turn architecture during follow-up call");
        }

        const fuContent = (fuResult.content ?? []) as ContentBlock[];
        const fuIsError = Boolean(fuResult.isError);
        const fuSerialized = JSON.stringify({ content: fuContent, structuredContent: fuResult });
        if (Buffer.byteLength(fuSerialized) > MAX_RESULT_BYTES) {
          throw new Error("Follow-up result exceeds 25 MB limit.");
        }

        followUpResults.push({
          content: fuContent,
          structuredContent: fuResult as Record<string, unknown>,
          isError: fuIsError,
          modelTurnsStarted: 0,
          ephemeralThread: true,
        });
      }
    }

    return {
      content,
      structuredContent: callResult as Record<string, unknown>,
      isError,
      modelTurnsStarted,
      ephemeralThread: true,
      followUpResults,
    };
  } finally {
    // Teardown: kill the process tree and await exit.
    if (proc && !proc.killed) {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }
      // Await process exit before removing temp tree.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        proc!.on("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    // Clean up temp.
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// Simple newline-delimited reader from a child process stdout.
function createLineReader(proc: ChildProcess) {
  let buffer = "";
  const pending: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let closed = false;
  let closeError: Error | null = null;

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    // Cap buffer while accumulating to prevent unbounded growth.
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
      const err = new Error("App-server line exceeds 8 MB limit.");
      for (const p of pending) p.reject(err);
      pending.length = 0;
      buffer = "";
      return;
    }
    drainLines();
  });

  proc.stdout!.on("close", () => {
    closed = true;
    for (const p of pending) {
      p.reject(closeError ?? new Error("App-server stdout closed unexpectedly."));
    }
    pending.length = 0;
  });

  proc.on("error", (err) => {
    closeError = err;
  });

  function drainLines() {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        // Reject all pending.
        const err = new Error("App-server line exceeds 8 MB limit.");
        for (const p of pending) p.reject(err);
        pending.length = 0;
        return;
      }
      if (pending.length > 0) {
        pending.shift()!.resolve(line);
      }
    }
  }

  return {
    next(timeoutMs: number): Promise<string> {
      // Check buffer first.
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        return Promise.resolve(line);
      }
      if (closed) {
        return Promise.reject(
          closeError ?? new Error("App-server stdout closed.")
        );
      }
      return new Promise<string>((resolve, reject) => {
        const entry = { resolve, reject };
        pending.push(entry);
        const timer = setTimeout(() => {
          const i = pending.indexOf(entry);
          if (i !== -1) {
            pending.splice(i, 1);
            reject(new Error(`App-server timeout after ${timeoutMs}ms.`));
          }
        }, timeoutMs);
        // Clear timeout on resolve.
        const origResolve = entry.resolve;
        entry.resolve = (line) => {
          clearTimeout(timer);
          origResolve(line);
        };
        const origReject = entry.reject;
        entry.reject = (err) => {
          clearTimeout(timer);
          origReject(err);
        };
      });
    },
  };
}
