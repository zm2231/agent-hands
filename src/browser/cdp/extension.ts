import { createConnection, type Socket } from "node:net";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createCDPClient } from "./client.js";
import type { CDPClient, CDPMessage, CDPTransport } from "./types.js";

const MAX_HOST_TO_EXTENSION_BYTES = 1024 * 1024;
const MAX_EXTENSION_TO_HOST_BYTES = 64 * 1024 * 1024;
export const CONNECTION_TIMEOUT_MS = 60_000;

type HostMessage = {
  id?: number;
  kind?: "auth" | "cdp" | "control" | "event" | "detached";
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number | string; message: string };
  ok?: boolean;
  op?: "listTabs" | "attach" | "detach" | "createTarget" | "disconnect";
  sessionId?: string;
  tabId?: number;
  token?: string;
  controllerId?: string;
  url?: string;
};

export interface ExtensionTab {
  tabId: number;
  title: string;
  url: string;
}

export interface ExtensionConnection {
  client: CDPClient;
  close(): Promise<void>;
}

function brokerSocketPath(): string {
  return process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "agent-hands-browser.sock");
}

function controllerDirectory(): string {
  return process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-hands", "browser-host.d");
}

function controllerPath(controllerId: string): string {
  return join(controllerDirectory(), `${controllerId}.json`);
}

async function writeControllerToken(controllerId: string, token: string): Promise<void> {
  await mkdir(controllerDirectory(), { recursive: true, mode: 0o700 });
  const path = controllerPath(controllerId);
  await writeFile(path, JSON.stringify({ token }), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function removeControllerToken(controllerId: string): Promise<void> {
  await rm(controllerPath(controllerId), { force: true });
}

function encode(message: HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_HOST_TO_EXTENSION_BYTES) throw new Error("Extension message exceeds the 1 MB native-messaging limit.");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function attachFrames(socket: Socket, onMessage: (message: HostMessage) => boolean | void, onClose: () => void): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer | string) => {
    buffered = Buffer.concat([buffered, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length > MAX_EXTENSION_TO_HOST_BYTES) {
        socket.destroy(new Error("Extension message exceeds the 64 MB native-messaging limit."));
        return;
      }
      if (buffered.length < length + 4) return;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      let message: HostMessage;
      try {
        message = JSON.parse(body.toString("utf8")) as HostMessage;
      } catch {
        socket.destroy(new Error("Extension message is not valid JSON."));
        return;
      }
      if (onMessage(message) === true) {
        socket.removeListener("data", onData);
        return;
      }
    }
  };
  socket.on("data", onData);
  socket.once("close", onClose);
  socket.once("error", onClose);
}

class ExtensionTransport implements CDPTransport {
  private readonly messageHandlers = new Set<(message: CDPMessage) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private closed = false;

  constructor(private readonly socket: Socket, private readonly controllerId: string) {
    attachFrames(socket, (message) => this.handle(message), () => this.notifyClose());
  }

  send(message: CDPMessage): void {
    if (this.closed) throw new Error("Extension transport is closed.");
    if (!message.method) throw new Error("CDP command method is required.");
    const envelope: HostMessage = {
      id: message.id,
      controllerId: this.controllerId,
      kind: "cdp",
      method: message.method,
      params: message.params,
      sessionId: message.sessionId,
    };
    if (message.method === "Target.getTargets") {
      envelope.kind = "control";
      envelope.op = "listTabs";
      delete envelope.method;
      delete envelope.params;
      delete envelope.sessionId;
    } else if (message.method === "Target.attachToTarget" && /^\d+$/.test(String(message.params?.targetId ?? ""))) {
      envelope.kind = "control";
      envelope.op = "attach";
      envelope.tabId = Number(message.params?.targetId);
      delete envelope.method;
      delete envelope.params;
      delete envelope.sessionId;
    } else if (message.method === "Target.createTarget") {
      envelope.kind = "control";
      envelope.op = "createTarget";
      envelope.url = String(message.params?.url ?? "about:blank");
      delete envelope.method;
      delete envelope.params;
      delete envelope.sessionId;
    } else if (message.method === "Target.detachFromTarget") {
      envelope.kind = "control";
      envelope.op = "detach";
      delete envelope.method;
      delete envelope.params;
    }
    this.socket.write(encode(envelope));
  }

  onMessage(handler: (message: CDPMessage) => void): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.socket.destroy();
    this.notifyClose();
  }

  private handle(message: HostMessage): void {
    if (message.kind === "event") {
      this.emit({ method: message.method, params: message.params, sessionId: message.sessionId });
      return;
    }
    if (message.kind === "detached") {
      this.emit({ method: "Target.detachedFromTarget", params: { sessionId: message.sessionId, targetId: String(message.tabId ?? "") }, sessionId: message.sessionId });
      return;
    }
    if (message.id == null) return;
    if (message.ok === false || message.error) {
      this.emit({ id: message.id, error: { code: typeof message.error?.code === "number" ? message.error.code : -32000, message: message.error?.message ?? "Extension command failed." } });
      return;
    }
    if (message.result && message.kind === "control" && message.op === "listTabs") {
      const tabs = (message.result.tabs as ExtensionTab[] | undefined) ?? [];
      this.emit({ id: message.id, result: { targetInfos: tabs.map((tab) => ({ targetId: String(tab.tabId), type: "page", title: tab.title, url: tab.url })) } });
      return;
    }
    this.emit({ id: message.id, result: message.result ?? {} });
  }

  private emit(message: CDPMessage): void {
    for (const handler of this.messageHandlers) handler(message);
  }

  private notifyClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
}

export async function createExtensionConnection(timeoutMs = CONNECTION_TIMEOUT_MS): Promise<ExtensionConnection> {
  const path = brokerSocketPath();
  const controllerId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  await writeControllerToken(controllerId, token);
  let socket!: Socket;
  try {
    socket = await new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let candidate: Socket | undefined;
    const finish = (error?: Error, connected?: Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(connected!);
    };
    const attempt = () => {
      if (settled) return;
      candidate = createConnection(path);
      candidate.once("error", () => { candidate?.destroy(); if (!settled) setTimeout(attempt, 100); });
      candidate.once("connect", () => {
        attachFrames(candidate!, (message) => {
          if (message.kind !== "auth" || message.controllerId !== controllerId || message.ok !== true) return;
          finish(undefined, candidate);
          return true;
        }, () => {});
        candidate!.write(encode({ kind: "auth", controllerId, token }));
      });
    };
    const timer = setTimeout(() => { candidate?.destroy(); finish(new Error(`Timed out waiting for the agent-hands Chrome broker at ${path}. Reload the extension and verify its native host installation.`)); }, timeoutMs);
    attempt();
    });
    const transport = new ExtensionTransport(socket, controllerId);
    return {
      client: createCDPClient(transport),
      async close() {
        try {
          await new Promise<void>((resolve, reject) => socket.write(encode({ kind: "control", op: "disconnect", controllerId }), (error) => error ? reject(error) : resolve()));
          await new Promise<void>((resolve) => socket.end(resolve));
        } finally {
          await removeControllerToken(controllerId);
        }
      },
    };
  } catch (error) {
    socket?.destroy();
    await removeControllerToken(controllerId);
    throw error;
  }
}
