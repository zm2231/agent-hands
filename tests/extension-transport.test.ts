import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
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

function frames(socket: Socket, handler: (value: Record<string, unknown>) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
      buffered = buffered.subarray(4 + length);
      handler(value);
    }
  });
}

describe("extension broker transport", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const prior = process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET;
  const priorControllerDirectory = process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR;
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    if (prior === undefined) delete process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET;
    else process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET = prior;
    if (priorControllerDirectory === undefined) delete process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR;
    else process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR = priorControllerDirectory;
  });

  it("routes two controllers independently and releases only the closing controller", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-broker-"));
    const path = join(directory, "broker.sock");
    process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET = path;
    process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR = join(directory, "controllers");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const active = new Set<string>();
    const server = createServer((socket) => frames(socket, (message) => {
      const controllerId = message.controllerId as string;
      if (message.kind === "auth") {
        active.add(controllerId);
        socket.write(frame({ kind: "auth", controllerId, ok: true }));
      } else if (message.op === "disconnect") active.delete(controllerId);
      else socket.write(frame({ id: message.id, kind: message.kind, op: message.op, controllerId, ok: true, result: message.op === "listTabs" ? { tabs: [{ tabId: controllerId.length, title: controllerId, url: "https://example.test" }] } : {} }));
    }));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const first = await createExtensionConnection();
    const second = await createExtensionConnection();
    expect((await first.client.send("Target.getTargets")).targetInfos).toHaveLength(1);
    expect((await second.client.send("Target.getTargets")).targetInfos).toHaveLength(1);
    expect(active.size).toBe(2);
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(active.size).toBe(1);
    await expect(second.client.send("Target.getTargets")).resolves.toMatchObject({ targetInfos: [{ url: "https://example.test" }] });
    await second.close();
  });

  it("reports a missing broker without creating a config rendezvous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-broker-"));
    process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET = join(directory, "missing.sock");
    process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR = join(directory, "controllers");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await expect(createExtensionConnection(20)).rejects.toThrow();
  });

  it("waits for a broker that starts while the extension host is reconnecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-broker-"));
    const path = join(directory, "broker.sock");
    process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET = path;
    process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR = join(directory, "controllers");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const server = createServer((socket) => frames(socket, (message) => {
      if (message.kind === "auth") socket.write(frame({ kind: "auth", controllerId: message.controllerId, ok: true }));
    }));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const connecting = createExtensionConnection(500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const connection = await connecting;
    await connection.close();
  });
});
