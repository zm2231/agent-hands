import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMPUTER_USE_PLUGIN_ROOT, type BrokerComponents } from "./verify.js";
import type { ContentBlock } from "../../kernel/types.js";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 25 * 1024 * 1024;

interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onElicitation?: (params: Record<string, unknown>) => Promise<{ action: string }>;
}

export interface SessionCallResult {
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
  modelTurnsStarted: number;
  ephemeralThread: boolean;
}

export class BrokerSession {
  private proc: ChildProcess | null = null;
  private reader: ReturnType<typeof createLineReader> | null = null;
  private threadId = "";
  private nextId = 1;
  private modelTurnsStarted = 0;
  private tempRoot = "";
  private workDir = "";
  private closed = false;
  private callActive = false;
  private _onClose: (() => void) | null = null;
  readonly components: BrokerComponents;

  constructor(components: BrokerComponents) {
    this.components = components;
  }

  get isAlive(): boolean {
    return !this.closed && this.proc !== null && !this.proc.killed;
  }

  set onClose(cb: () => void) {
    this._onClose = cb;
  }

  async start(): Promise<void> {
    try {
      this.tempRoot = await mkdtemp(join(tmpdir(), "direct-computer-use."));
      const codexHome = join(this.tempRoot, "codex-home");
      this.workDir = join(this.tempRoot, "work");
      await mkdir(codexHome, { mode: 0o700 });
      await writeFile(join(codexHome, "config.toml"), "", { mode: 0o600 });
      const { chmod } = await import("node:fs/promises");
      await chmod(codexHome, 0o700);
      await mkdir(this.workDir, { mode: 0o700 });

      const env: Record<string, string> = {
        HOME: this.tempRoot,
        CODEX_HOME: codexHome,
        TMPDIR: this.tempRoot,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        NO_COLOR: "1",
        CLICOLOR: "0",
      };
      for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"]) {
        if (process.env[key]) env[key] = process.env[key]!;
      }

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
        "-c", `mcp_servers={"computer-use" = { command = ${JSON.stringify(this.components.clientPath)}, args = ["mcp"], cwd = ${JSON.stringify(this.workDir)}, enabled = true, startup_timeout_sec = 30, tool_timeout_sec = 120 }}`,
        "-c", "plugins={}",
      ];

      this.proc = spawn(
        this.components.codexPath,
        [...configArgs, "app-server", "--stdio"],
        { cwd: this.workDir, env, stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false }
      );

      this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") this.close().catch(() => {});
      });
      this.proc.once("error", () => this.close().catch(() => {}));
      this.proc.once("close", () => {
        this.closed = true;
        this.cleanup().catch(() => {});
        const cb = this._onClose;
        this._onClose = null;
        cb?.();
      });
      this.proc.stderr?.setEncoding("utf8");
      this.proc.stderr?.on("data", () => {});

      this.reader = createLineReader(this.proc);

      await this.request("initialize", {
        clientInfo: { name: "agent-hands", title: "agent-hands", version: "0.1.0" },
        capabilities: { mcpServerOpenaiFormElicitation: true },
      }, 15_000);

      this.send({ method: "initialized" });

      const threadResult = await this.request("thread/start", {
        cwd: this.workDir,
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
        throw new Error("App-server did not attest an empty pathless ephemeral runtime context.");
      }
      this.threadId = thread.id;

      const inventoryResult = await this.request("mcpServerStatus/list", {
        threadId: this.threadId,
        detail: "toolsAndAuthOnly",
      }, 45_000);

      const inventoryData = (inventoryResult.data ?? inventoryResult.servers ?? []) as any[];
      const cuServer = inventoryData.find((s: any) => s.name === "computer-use");
      if (!cuServer) throw new Error("Inventory missing computer-use server.");

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
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private callQueue: Promise<any> = Promise.resolve();

  call(method: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<SessionCallResult> {
    if (this.closed) throw new Error("Session is closed.");

    const queued = this.callQueue.then(async () => {
      if (this.closed) throw new Error("Session is closed.");
      this.callActive = true;

      try {
        if (opts.signal?.aborted) throw new Error("Request cancelled.");

        const abortHandler = opts.signal
          ? () => { this.close().catch(() => {}); }
          : null;
        if (abortHandler) opts.signal!.addEventListener("abort", abortHandler, { once: true });

        try {
          const turnsBeforeCall = this.modelTurnsStarted;

          const raw = await this.request("mcpServer/tool/call", {
            threadId: this.threadId,
            server: "computer-use",
            tool: method,
            arguments: args,
          }, opts.timeoutMs ?? 120_000, opts.onElicitation);

          if (this.modelTurnsStarted > turnsBeforeCall) {
            await this.close();
            throw new Error("violated the zero-model-turn architecture");
          }

          const content = (raw.content ?? []) as ContentBlock[];
          const isError = Boolean(raw.isError);

          const serialized = JSON.stringify({ content, structuredContent: raw });
          if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
            throw new Error("Result exceeds 25 MB limit.");
          }

          return {
            content,
            structuredContent: raw as Record<string, unknown>,
            isError,
            modelTurnsStarted: 0,
            ephemeralThread: true,
          };
        } catch (err) {
          await this.close();
          throw err;
        } finally {
          if (abortHandler && opts.signal) {
            opts.signal.removeEventListener("abort", abortHandler);
          }
        }
      } finally {
        this.callActive = false;
      }
    });

    this.callQueue = queued.catch(() => {});
    return queued;
  }

  private closePromise: Promise<void> | null = null;

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const cb = this._onClose;
      this._onClose = null;
      cb?.();
      await this.killProcess();
      await this.cleanup();
    })();
    return this.closePromise;
  }

  private async killProcess(): Promise<void> {
    const proc = this.proc;
    const pid = proc?.pid;
    if (!proc || !pid) return;

    const { spawnSync } = await import("node:child_process");
    const pExists = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const pgExists = (p: number) => { try { process.kill(-p, 0); return true; } catch { return false; } };

    const collectDescendants = (root: number): Set<number> => {
      const found = new Set<number>();
      const queue = [root];
      while (queue.length > 0 && found.size < 256) {
        const parent = queue.shift()!;
        const r = spawnSync("/usr/bin/pgrep", ["-P", String(parent)], { encoding: "utf8", timeout: 2000 });
        if (r.error || (r.status !== 0 && r.status !== 1)) continue;
        for (const tok of (r.stdout ?? "").trim().split(/\s+/)) {
          const c = Number(tok);
          if (Number.isSafeInteger(c) && c > 1 && c !== root && !found.has(c)) { found.add(c); queue.push(c); }
        }
      }
      return found;
    };

    const collectByCwd = (): Set<number> => {
      if (!this.workDir) return new Set();
      const r = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "+d", this.workDir, "-Fp"], { encoding: "utf8", timeout: 3000 });
      const pids = new Set<number>();
      for (const line of (r.stdout ?? "").split("\n")) {
        const m = line.match(/^p(\d+)$/);
        if (m) { const p = Number(m[1]); if (Number.isSafeInteger(p) && p > 1 && p !== process.pid) pids.add(p); }
      }
      return pids;
    };

    // Enumerate descendants.
    const descendants = new Set<number>();
    for (const c of collectDescendants(pid)) descendants.add(c);
    for (const c of collectByCwd()) descendants.add(c);

    // SIGSTOP the process group to freeze spawning.
    try { process.kill(-pid, "SIGSTOP"); } catch {
      try { proc.kill("SIGSTOP"); } catch { /* exited */ }
    }

    // Stabilize: re-enumerate up to 16 passes.
    for (let pass = 0; pass < 16; pass++) {
      let added = false;
      for (const c of collectDescendants(pid)) {
        if (!descendants.has(c)) { descendants.add(c); added = true; try { process.kill(c, "SIGSTOP"); } catch {} }
      }
      for (const c of collectByCwd()) {
        if (!descendants.has(c)) { descendants.add(c); added = true; try { process.kill(c, "SIGSTOP"); } catch {} }
      }
      if (!added && pass > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // SIGKILL everything.
    for (const c of descendants) { try { process.kill(c, "SIGKILL"); } catch {} }
    try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }

    // Post-kill sweep.
    for (let pass = 0; pass < 2; pass++) {
      await new Promise((r) => setTimeout(r, 25));
      for (const c of collectByCwd()) { try { process.kill(c, "SIGKILL"); } catch {} }
    }

    // Wait for exit (up to 1.5s).
    for (let elapsed = 0; elapsed < 1500; elapsed += 25) {
      if (!pgExists(pid) && [...descendants].every((c) => !pExists(c))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private async cleanup(): Promise<void> {
    if (this.tempRoot) {
      await rm(this.tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) throw new Error("App-server stdin unavailable.");
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private async request(
    reqMethod: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    onElicitation?: (params: Record<string, unknown>) => Promise<{ action: string }>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.send({ method: reqMethod, id, params });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Request timed out after ${timeoutMs}ms.`);

      const line = await this.reader!.next(remaining);
      const msg = JSON.parse(line);

      if (msg.method && (msg.method.startsWith("turn/") || msg.method.startsWith("item/"))) {
        this.modelTurnsStarted++;
        throw new Error("Model turn detected: violated the zero-model-turn architecture.");
      }

      if (msg.method === "mcpServer/elicitation/request" && msg.id != null) {
        let action = "cancel";
        if (onElicitation) {
          const elicitRemaining = deadline - Date.now();
          if (elicitRemaining <= 0) throw new Error(`Request timed out during elicitation after ${timeoutMs}ms.`);
          let elicitTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              onElicitation(msg.params ?? {}),
              new Promise<never>((_, reject) => {
                elicitTimer = setTimeout(() => reject(new Error(`Elicitation timed out after ${timeoutMs}ms.`)), elicitRemaining);
              }),
            ]);
            if (["accept", "decline", "cancel"].includes(result.action)) action = result.action;
          } catch { action = "cancel"; } finally { clearTimeout(elicitTimer); }
        }
        this.send({ method: msg.method, id: msg.id, params: { action } } as any);
        continue;
      }

      if (msg.method && msg.id != null) {
        this.send({
          method: msg.method,
          id: msg.id,
          params: { error: { code: -32601, message: "Unsupported server request" } },
        } as any);
        continue;
      }

      if (msg.id === id) {
        if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
        return msg.result ?? {};
      }
    }
  }
}

function createLineReader(proc: ChildProcess) {
  let buffer = "";
  const pending: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let closed = false;
  let closeError: Error | null = null;

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
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

  proc.on("error", (err) => { closeError = err; });

  function drainLines() {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
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
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        return Promise.resolve(line);
      }
      if (closed) {
        return Promise.reject(closeError ?? new Error("App-server stdout closed."));
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
        const origResolve = entry.resolve;
        entry.resolve = (line) => { clearTimeout(timer); origResolve(line); };
        const origReject = entry.reject;
        entry.reject = (err) => { clearTimeout(timer); origReject(err); };
      });
    },
  };
}
