import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createCDPClient } from "./client.js";
import type { CDPClient, CDPMessage, CDPTransport } from "./types.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 60_000;

type HostMessage = {
  id?: number;
  kind?: "auth" | "cdp" | "control" | "event" | "detached";
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number | string; message: string };
  ok?: boolean;
  op?: "listTabs" | "attach" | "detach" | "createTarget";
  sessionId?: string;
  tabId?: number;
  token?: string;
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

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-hands", "browser-host.json");
}

function socketPath(): string {
  return join(tmpdir(), `agent-hands-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
}

function encode(message: HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME_BYTES) throw new Error("Extension message exceeds the 1 MB native-messaging limit.");
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
      if (length > MAX_FRAME_BYTES) {
        socket.destroy(new Error("Extension message exceeds the 1 MB native-messaging limit."));
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

  constructor(private readonly socket: Socket) {
    attachFrames(socket, (message) => this.handle(message), () => this.notifyClose());
  }

  send(message: CDPMessage): void {
    if (this.closed) throw new Error("Extension transport is closed.");
    if (!message.method) throw new Error("CDP command method is required.");
    const envelope: HostMessage = {
      id: message.id,
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

export async function createExtensionConnection(): Promise<ExtensionConnection> {
  const path = socketPath();
  const token = randomBytes(32).toString("hex");
  const config = configPath();
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  await writeFile(config, JSON.stringify({ socketPath: path, token }), { mode: 0o600 });
  await chmod(config, 0o600);

  let server: Server | undefined;
  let socket: Socket | undefined;
  try {
    socket = await new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for the agent-hands Chrome extension. Load extension/ unpacked and register host/native-host.mjs as com.zmerchant.agenthands.`)), CONNECTION_TIMEOUT_MS);
      server = createServer((candidate) => {
        if (socket) {
          candidate.destroy(new Error("Browser host already connected."));
          return;
        }
        attachFrames(candidate, (message) => {
          if (message.kind !== "auth" || message.token !== token) {
            candidate.destroy(new Error("Unauthenticated browser host."));
            return;
          }
          clearTimeout(timer);
          socket = candidate;
          resolve(candidate);
          return true;
        }, () => {});
      });
      server.once("error", reject);
      server.listen(path);
    });
    const transport = new ExtensionTransport(socket);
    return {
      client: createCDPClient(transport),
      async close() {
        transport.close();
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    socket?.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await rm(path, { force: true });
    throw error;
  }
}
