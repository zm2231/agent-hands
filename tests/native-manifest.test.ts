import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { configDir, launcherPath, manifestJson, writeLauncher } from "../host/manifest.mjs";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function receive(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const size = buffered.readUInt32LE(0);
      if (buffered.length < size + 4) return;
      cleanup();
      resolveMessage(JSON.parse(buffered.subarray(4, size + 4).toString("utf8")) as Record<string, unknown>);
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

describe("native-messaging manifest launcher", () => {
  const processes: ChildProcess[] = [];
  const servers = new Set<ReturnType<typeof createServer>>();
  const directories: string[] = [];
  const originalConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(async () => {
    for (const process of processes.splice(0)) process.kill();
    for (const server of servers) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    servers.clear();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
  });

  it("emits a manifest whose path is an executable launcher that runs the native host on the installation node", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-manifest-"));
    directories.push(directory);
    process.env.XDG_CONFIG_HOME = directory;

    const hostScript = resolve("host/native-host.mjs");
    const launcher = await writeLauncher(hostScript);

    expect(launcher).toBe(launcherPath());
    expect(launcher.startsWith(configDir())).toBe(true);
    await expect(access(launcher, constants.X_OK)).resolves.toBeUndefined();

    const manifest = manifestJson(launcher, ["abc"]);
    expect(manifest.path).toBe(launcher);
    expect(manifest.allowed_origins).toEqual(["chrome-extension://abc/"]);

    const socketPath = join(directory, "host.sock");
    const configDirectory = configDir();
    const token = "launcher-token";
    let browserSocket: Socket | undefined;
    const authenticated = new Promise<void>((resolveAuth, reject) => {
      const server = createServer((socket) => {
        browserSocket = socket;
        void receive(socket).then((message) => {
          expect(message).toEqual({ kind: "auth", token });
          resolveAuth();
        }, reject);
      });
      servers.add(server);
      server.listen(socketPath);
    });
    await writeFile(join(configDirectory, "browser-host.json"), JSON.stringify({ socketPath, token }));

    const host = spawn(manifest.path, [], { env: { ...process.env, XDG_CONFIG_HOME: directory }, stdio: ["pipe", "pipe", "pipe"] });
    processes.push(host);
    await authenticated;

    const response = receive(host.stdout);
    host.stdin.write(frame({ id: 6, kind: "control", op: "listTabs" }));
    const relayed = receive(browserSocket!);
    await expect(relayed).resolves.toEqual({ id: 6, kind: "control", op: "listTabs" });

    browserSocket!.write(frame({ id: 7, kind: "control", op: "listTabs", ok: true, result: { tabs: [] } }));
    await expect(response).resolves.toEqual({ id: 7, kind: "control", op: "listTabs", ok: true, result: { tabs: [] } });

    const launcherSource = await readFile(launcher, "utf8");
    expect(launcherSource).toContain(process.execPath);
  });
});
