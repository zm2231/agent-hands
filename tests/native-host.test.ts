import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
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
    const host = spawn(process.execPath, [resolve("host/native-host.mjs")], { env: { ...process.env, AGENT_HANDS_BROWSER_BROKER_SOCKET: path }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    const first = await open(path);
    const second = await open(path);
    first.write(frame({ kind: "auth", controllerId: "one", token: "a".repeat(32) }));
    second.write(frame({ kind: "auth", controllerId: "two", token: "b".repeat(32) }));
    await expect(nextFrame(first)).resolves.toMatchObject({ kind: "auth", controllerId: "one", ok: true });
    await expect(nextFrame(second)).resolves.toMatchObject({ kind: "auth", controllerId: "two", ok: true });
    first.write(frame({ id: 1, kind: "control", op: "listTabs", controllerId: "one" }));
    second.write(frame({ id: 2, kind: "control", op: "listTabs", controllerId: "two" }));
    await expect(nextFrame(host.stdout)).resolves.toMatchObject({ id: 1, controllerId: "one" });
    await expect(nextFrame(host.stdout)).resolves.toMatchObject({ id: 2, controllerId: "two" });
    host.stdin.write(frame({ id: 2, controllerId: "two", kind: "control", ok: true, result: {} }));
    await expect(nextFrame(second)).resolves.toMatchObject({ id: 2, controllerId: "two" });
    first.destroy();
    await expect(nextFrame(host.stdout)).resolves.toMatchObject({ op: "disconnect", controllerId: "one" });
    second.destroy();
  });
});
