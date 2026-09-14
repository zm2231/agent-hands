import { describe, it, expect, beforeAll } from "vitest";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const proxyPath = join(repoRoot, "dist", "desktop", "broker", "cua-proxy.js");
const fixtures = join(here, "fixtures");

beforeAll(() => {
  execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
}, 120_000);

function runProxy(clientScript: string): ChildProcessWithoutNullStreams {
  const proxy = spawn(process.execPath, [proxyPath, process.execPath, join(fixtures, clientScript)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proxy.stdin.on("error", () => {});
  return proxy;
}

function firstLine(proxy: ChildProcessWithoutNullStreams, match: RegExp): Promise<string> {
  return new Promise((resolve) => {
    let acc = "";
    proxy.stdout.setEncoding("utf8");
    const onData = (d: string) => {
      acc += d;
      const line = acc.split("\n").find((l) => match.test(l));
      if (line) {
        proxy.stdout.off("data", onData);
        resolve(line);
      }
    };
    proxy.stdout.on("data", onData);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("cua-proxy process lifecycle", () => {
  it("survives the client closing its stdin without an unhandled error", async () => {
    const proxy = runProxy("cua-proxy-client-close-stdin.mjs");
    let stderr = "";
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", (d) => (stderr += d));

    await firstLine(proxy, /ready/);
    for (let i = 0; i < 100; i++) proxy.stdin.write(`{"jsonrpc":"2.0","id":${i},"method":"ping"}\n`);

    const code: number = await new Promise((resolve) => proxy.on("exit", (c) => resolve(c ?? -1)));
    expect(stderr).not.toMatch(/EPIPE|Unhandled|uncaughtException|not be handled/i);
    expect(code).toBe(0);
  });

  it("terminates the signed client when the downstream reader closes", async () => {
    const proxy = runProxy("cua-proxy-client-downstream.mjs");
    proxy.stderr.resume();

    const pidLine = await firstLine(proxy, /^pid:/);
    const childPid = Number.parseInt(pidLine.slice(4), 10);
    expect(alive(childPid)).toBe(true);

    proxy.stdout.destroy();

    await new Promise((r) => proxy.on("exit", r));
    for (let i = 0; i < 20 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(childPid)).toBe(false);
  }, 20_000);

  it("keeps proxy memory bounded when the reader stalls (child.stdin backpressure)", async () => {
    const proxy = runProxy("cua-proxy-client-stalled.mjs");
    proxy.stdout.resume();
    proxy.stderr.resume();

    const chunk = "z".repeat(64 * 1024) + "\n";
    for (let i = 0; i < 3072; i++) proxy.stdin.write(chunk);

    await new Promise((r) => setTimeout(r, 1000));
    const rssKib = Number.parseInt(
      execSync(`ps -o rss= -p ${proxy.pid}`, { encoding: "utf8" }).trim(),
      10
    );

    proxy.stdin.destroy();
    proxy.kill("SIGKILL");
    await new Promise((r) => proxy.on("exit", r));

    expect(rssKib).toBeGreaterThan(0);
    expect(rssKib).toBeLessThan(150_000);
  }, 20_000);

  it("preserves ordering and delivers every record under a slow reader", async () => {
    const proxy = runProxy("cua-proxy-client-slow.mjs");
    let stdout = "";
    let stderr = "";
    proxy.stdout.setEncoding("utf8");
    proxy.stdout.on("data", (d) => (stdout += d));
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", (d) => (stderr += d));

    const records = 40;
    const filler = "x".repeat(64 * 1024);
    for (let i = 0; i < records; i++) proxy.stdin.write(`${i}:${filler}\n`);
    proxy.stdin.end();

    const code: number = await new Promise((resolve) => proxy.on("exit", (c) => resolve(c ?? -1)));
    expect(stderr).not.toMatch(/EPIPE|Unhandled|uncaughtException/i);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`done ${records} true`);
  }, 20_000);
});
