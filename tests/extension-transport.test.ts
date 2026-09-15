import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionConnection } from "../src/browser/cdp/extension.js";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function readFrames(socket: Socket, handler: (message: Record<string, unknown>) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32LE(0);
      if (buffered.length < size + 4) return;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      handler(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
    }
  });
}

async function readConfig(configHome: string): Promise<{ socketPath: string; token: string }> {
  const path = join(configHome, "agent-hands", "browser-host.json");
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as { socketPath: string; token: string };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("browser-host.json was never written");
}

async function connectWithRetry(socketPath: string): Promise<Socket> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const socket = connect(socketPath);
    const outcome = await new Promise<"ok" | "retry">((resolve) => {
      socket.once("connect", () => resolve("ok"));
      socket.once("error", () => resolve("retry"));
    });
    if (outcome === "ok") return socket;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("host socket never accepted a connection");
}

describe("extension transport (real createExtensionConnection)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousHome = process.env.XDG_CONFIG_HOME;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousHome;
  });

  it("authenticates a host and routes createTarget as a control operation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hands-ext-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.env.XDG_CONFIG_HOME = dir;

    const connectionPromise = createExtensionConnection();
    const config = await readConfig(dir);
    const host = await connectWithRetry(config.socketPath);
    cleanups.push(() => void host.destroy());

    const received: Array<Record<string, unknown>> = [];
    readFrames(host, (message) => {
      received.push(message);
      if (message.kind === "control" && message.op === "createTarget") {
        host.write(frame({ id: message.id, kind: "control", op: "createTarget", ok: true, result: { targetId: 42 } }));
      }
    });

    host.write(frame({ kind: "auth", token: config.token }));
    const connection = await connectionPromise;
    cleanups.push(() => connection.close());

    const result = await connection.client.send("Target.createTarget", { url: "https://example.com" });

    const control = received.find((message) => message.op === "createTarget");
    expect(control).toMatchObject({ kind: "control", op: "createTarget", url: "https://example.com" });
    expect(control).not.toHaveProperty("method");
    expect(result).toEqual({ targetId: 42 });
  });

  it("removes the socket and config after a timed out connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hands-ext-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.env.XDG_CONFIG_HOME = dir;

    const connection = createExtensionConnection(20);
    const config = await readConfig(dir);

    await expect(connection).rejects.toThrow("Timed out waiting");
    await expect(access(config.socketPath)).rejects.toThrow();
    await expect(readFile(join(dir, "agent-hands", "browser-host.json"), "utf8")).rejects.toThrow();
  });

  it("drops an unauthenticated host and keeps the authenticated controller working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hands-ext-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.env.XDG_CONFIG_HOME = dir;

    const connectionPromise = createExtensionConnection();
    const config = await readConfig(dir);

    const imposter = await connectWithRetry(config.socketPath);
    const imposterClosed = new Promise<void>((resolve) => imposter.once("close", () => resolve()));
    imposter.write(frame({ kind: "auth", token: "wrong-token" }));
    await imposterClosed;

    const host = await connectWithRetry(config.socketPath);
    cleanups.push(() => void host.destroy());
    readFrames(host, (message) => {
      if (message.kind === "control" && message.op === "listTabs") {
        host.write(frame({ id: message.id, kind: "control", op: "listTabs", ok: true, result: { tabs: [{ tabId: 7, title: "T", url: "https://a" }] } }));
      }
    });
    host.write(frame({ kind: "auth", token: config.token }));
    const connection = await connectionPromise;
    cleanups.push(() => connection.close());

    const tabs = await connection.client.send("Target.getTargets");
    expect(tabs).toEqual({ targetInfos: [{ targetId: "7", type: "page", title: "T", url: "https://a" }] });
  });

  it("refuses a second host without crashing the process and keeps the first controller working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-hands-ext-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.env.XDG_CONFIG_HOME = dir;

    const connectionPromise = createExtensionConnection();
    const config = await readConfig(dir);

    const host = await connectWithRetry(config.socketPath);
    cleanups.push(() => void host.destroy());
    readFrames(host, (message) => {
      if (message.kind === "control" && message.op === "listTabs") {
        host.write(frame({ id: message.id, kind: "control", op: "listTabs", ok: true, result: { tabs: [{ tabId: 7, title: "T", url: "https://a" }] } }));
      }
    });
    host.write(frame({ kind: "auth", token: config.token }));
    const connection = await connectionPromise;
    cleanups.push(() => connection.close());

    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    cleanups.push(() => process.off("uncaughtException", onUncaught));

    const second = await connectWithRetry(config.socketPath);
    const secondClosed = new Promise<void>((resolve) => second.once("close", () => resolve()));
    second.write(frame({ kind: "auth", token: config.token }));
    await secondClosed;
    await new Promise((resolve) => setImmediate(resolve));

    expect(uncaught).toEqual([]);

    const tabs = await connection.client.send("Target.getTargets");
    expect(tabs).toEqual({ targetInfos: [{ targetId: "7", type: "page", title: "T", url: "https://a" }] });
  });
});
