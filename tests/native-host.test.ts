import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function nextFrame(socket: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", function onData(chunk: Buffer) {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4 || buffered.length < buffered.readUInt32LE(0) + 4) return;
      socket.off("data", onData);
      resolve(JSON.parse(buffered.subarray(4, buffered.readUInt32LE(0) + 4).toString("utf8")) as Record<string, unknown>);
    });
  });
}

async function open(path: string): Promise<Socket> {
  for (;;) {
    const socket = connect(path);
    if (await new Promise<boolean>((resolve) => { socket.once("connect", () => resolve(true)); socket.once("error", () => resolve(false)); })) return socket;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function closed(socket: Socket): Promise<boolean> {
  return new Promise((resolve) => socket.once("close", resolve));
}

describe("native browser broker", () => {
  const processes: ChildProcess[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const child of processes.splice(0)) child.kill();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("multiplexes authenticated controllers and routes native replies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const path = join(directory, "broker.sock");
    const controllerDirectory = join(directory, "controllers");
    await mkdir(controllerDirectory);
    await Promise.all([
      writeFile(join(controllerDirectory, "11111111111111111111111111111111.json"), JSON.stringify({ token: "a".repeat(64) })),
      writeFile(join(controllerDirectory, "22222222222222222222222222222222.json"), JSON.stringify({ token: "b".repeat(64) })),
    ]);
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path, AGENT_HANDS_BROWSER_CONTROLLER_DIR: controllerDirectory }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const first = await open(path);
    const second = await open(path);
    const firstId = "11111111111111111111111111111111";
    const secondId = "22222222222222222222222222222222";
    first.write(frame({ kind: "auth", controllerId: firstId, token: "a".repeat(64) }));
    second.write(frame({ kind: "auth", controllerId: secondId, token: "b".repeat(64) }));
    await expect(nextFrame(first)).resolves.toMatchObject({ kind: "auth", controllerId: firstId, ok: true });
    await expect(nextFrame(second)).resolves.toMatchObject({ kind: "auth", controllerId: secondId, ok: true });
    first.write(frame({ id: 1, kind: "control", op: "listTabs", controllerId: firstId }));
    await expect(nextFrame(host.stdout)).resolves.toMatchObject({ id: 1, controllerId: firstId });
    second.write(frame({ id: 2, kind: "control", op: "listTabs", controllerId: secondId }));
    await expect(nextFrame(host.stdout)).resolves.toMatchObject({ id: 2, controllerId: secondId });
    host.stdin.write(frame({ id: 2, controllerId: secondId, kind: "control", ok: true, result: {} }));
    await expect(nextFrame(second)).resolves.toMatchObject({ id: 2, controllerId: secondId });
    const unauthenticated = await open(path);
    unauthenticated.write(frame({ kind: "auth", controllerId: firstId, token: "wrong" }));
    await expect(closed(unauthenticated)).resolves.toBe(false);
    first.destroy();
    await expect(nextFrame(host.stdout)).resolves.toMatchObject({ op: "disconnect", controllerId: firstId });
    second.destroy();
  });

  it("relays a native result larger than 1 MB to its authenticated controller", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const path = join(directory, "broker.sock");
    const controllerDirectory = join(directory, "controllers");
    const controllerId = "33333333333333333333333333333333";
    await mkdir(controllerDirectory);
    await writeFile(join(controllerDirectory, `${controllerId}.json`), JSON.stringify({ token: "c".repeat(64) }));
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path, AGENT_HANDS_BROWSER_CONTROLLER_DIR: controllerDirectory }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const client = await open(path);
    client.write(frame({ kind: "auth", controllerId, token: "c".repeat(64) }));
    await expect(nextFrame(client)).resolves.toMatchObject({ kind: "auth", controllerId, ok: true });
    const data = "A".repeat(1024 * 1024 + 1);
    host.stdin.write(frame({ id: 8, controllerId, kind: "cdp", ok: true, result: { data } }));
    await expect(nextFrame(client)).resolves.toEqual({ id: 8, controllerId, kind: "cdp", ok: true, result: { data } });
    expect(host.exitCode).toBeNull();
    client.destroy();
  });

  it("removes a controller token file when its connection closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const path = join(directory, "broker.sock");
    const controllerDirectory = join(directory, "controllers");
    const controllerId = "44444444444444444444444444444444";
    const tokenPath = join(controllerDirectory, `${controllerId}.json`);
    await mkdir(controllerDirectory);
    await writeFile(tokenPath, JSON.stringify({ token: "d".repeat(64) }));
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path, AGENT_HANDS_BROWSER_CONTROLLER_DIR: controllerDirectory }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const client = await open(path);
    client.write(frame({ kind: "auth", controllerId, token: "d".repeat(64) }));
    await expect(nextFrame(client)).resolves.toMatchObject({ kind: "auth", controllerId, ok: true });
    client.destroy();
    await nextFrame(host.stdout);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await access(tokenPath).then(() => true, () => false))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(access(tokenPath)).rejects.toThrow();
  });

  it("rebinds over a stale socket file left by a dead broker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const path = join(directory, "broker.sock");
    const controllerDirectory = join(directory, "controllers");
    const controllerId = "55555555555555555555555555555555";
    await mkdir(controllerDirectory);
    await writeFile(join(controllerDirectory, `${controllerId}.json`), JSON.stringify({ token: "e".repeat(64) }));
    const env = { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path, AGENT_HANDS_BROWSER_CONTROLLER_DIR: controllerDirectory };
    const dead = spawn(process.execPath, [resolve("host/native-host.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
    const early = await open(path);
    early.destroy();
    dead.kill("SIGKILL");
    await new Promise((resolve) => dead.once("exit", resolve));
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const client = await open(path);
    client.write(frame({ kind: "auth", controllerId, token: "e".repeat(64) }));
    await expect(nextFrame(client)).resolves.toMatchObject({ kind: "auth", controllerId, ok: true });
    client.destroy();
  });

  it("fails closed on malformed native frames", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const path = join(directory, "broker.sock");
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const oversized = Buffer.allocUnsafe(4);
    oversized.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
    host.stdin.write(oversized);
    await expect(new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)))).resolves.toBe(1);
  });

  it("fails closed on invalid native JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-native-host-"));
    directories.push(directory);
    const path = join(directory, "broker.sock");
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const invalid = Buffer.from("not-json");
    const malformed = Buffer.allocUnsafe(4 + invalid.length);
    malformed.writeUInt32LE(invalid.length, 0);
    invalid.copy(malformed, 4);
    host.stdin.write(malformed);
    await expect(new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)))).resolves.toBe(1);
  });
});
