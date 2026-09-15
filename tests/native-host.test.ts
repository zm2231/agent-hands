import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function receive(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const size = buffered.readUInt32LE(0);
      if (buffered.length < size + 4) return;
      cleanup();
      resolve(JSON.parse(buffered.subarray(4, size + 4).toString("utf8")) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

describe("native browser host", () => {
  const processes: ChildProcess[] = [];
  const servers = new Set<ReturnType<typeof createServer>>();
  const directories: string[] = [];

  afterEach(async () => {
    for (const process of processes.splice(0)) process.kill();
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.clear();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("authenticates and relays length-prefixed native messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const socketPath = join(directory, "host.sock");
    const configDirectory = join(directory, "config", "agent-hands");
    const token = "test-token";
    let browserSocket: Socket | undefined;
    const authenticated = new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        browserSocket = socket;
        void receive(socket).then((message) => {
          expect(message).toEqual({ kind: "auth", token });
          resolve();
        }, reject);
      });
      servers.add(server);
      server.listen(socketPath);
    });
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "browser-host.json"), JSON.stringify({ socketPath, token }));

    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config") }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    await authenticated;
    const response = receive(host.stdout);
    const outbound = frame({ id: 6, kind: "control", op: "listTabs" });
    const relayed = receive(browserSocket!);
    host.stdin.write(outbound.subarray(0, 3));
    host.stdin.write(outbound.subarray(3));

    await expect(relayed).resolves.toEqual({ id: 6, kind: "control", op: "listTabs" });

    browserSocket!.write(frame({ id: 7, kind: "control", op: "listTabs", ok: true, result: { tabs: [] } }));

    await expect(response).resolves.toEqual({ id: 7, kind: "control", op: "listTabs", ok: true, result: { tabs: [] } });
  });

  it("relays a native result larger than 1 MB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const socketPath = join(directory, "host.sock");
    const configDirectory = join(directory, "config", "agent-hands");
    const token = "test-token";
    let browserSocket: Socket | undefined;
    const authenticated = new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        browserSocket = socket;
        void receive(socket).then((message) => {
          expect(message).toEqual({ kind: "auth", token });
          resolve();
        }, reject);
      });
      servers.add(server);
      server.listen(socketPath);
    });
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "browser-host.json"), JSON.stringify({ socketPath, token }));

    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config") }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    await authenticated;
    const data = "A".repeat(1024 * 1024 + 1);
    const relayed = receive(browserSocket!);
    host.stdin.write(frame({ id: 8, kind: "cdp", ok: true, result: { data } }));

    await expect(relayed).resolves.toEqual({ id: 8, kind: "cdp", ok: true, result: { data } });
    expect(host.exitCode).toBeNull();
  });

  it("fails closed on an oversized native frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const socketPath = join(directory, "host.sock");
    const configDirectory = join(directory, "config", "agent-hands");
    let browserSocket: Socket | undefined;
    let resolveConnected: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const server = createServer((socket) => {
      browserSocket = socket;
      resolveConnected();
    });
    servers.add(server);
    server.listen(socketPath);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "browser-host.json"), JSON.stringify({ socketPath, token: "test-token" }));

    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config") }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    await connected;
    const oversized = Buffer.allocUnsafe(4);
    oversized.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
    host.stdin.write(oversized);

    await expect(new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)))).resolves.toBe(1);
    browserSocket?.destroy();
  });

  it("fails closed on invalid native JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const socketPath = join(directory, "host.sock");
    const configDirectory = join(directory, "config", "agent-hands");
    let browserSocket: Socket | undefined;
    let resolveConnected: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const server = createServer((socket) => {
      browserSocket = socket;
      resolveConnected();
    });
    servers.add(server);
    server.listen(socketPath);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "browser-host.json"), JSON.stringify({ socketPath, token: "test-token" }));

    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config") }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    await connected;
    const invalid = Buffer.from("not-json");
    const malformed = Buffer.allocUnsafe(4 + invalid.length);
    malformed.writeUInt32LE(invalid.length, 0);
    invalid.copy(malformed, 4);
    host.stdin.write(malformed);

    await expect(new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)))).resolves.toBe(1);
    browserSocket?.destroy();
  });
});
