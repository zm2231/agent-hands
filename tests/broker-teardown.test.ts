import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllBrokerProcessesNow, trackBrokerProcess } from "../src/desktop/broker/session.js";
import { CODEX_PATH } from "../src/desktop/broker/verify.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

describe("broker teardown", () => {
  it("kills a tracked process group and its children synchronously", async () => {
    const proc = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
    trackBrokerProcess(proc);
    let child = 0;
    await waitFor(() => {
      const r = spawnSync("pgrep", ["-P", String(proc.pid)], { encoding: "utf8" });
      child = Number((r.stdout ?? "").trim().split(/\s+/)[0]);
      return child > 0;
    });
    expect(child).toBeGreaterThan(0);

    killAllBrokerProcessesNow();

    expect(await waitFor(() => !alive(proc.pid!) && !alive(child))).toBe(true);
  });

  const entry = join(__dirname, "..", "dist", "index.js");

  async function startWithDesktopSession() {
    const tmp = mkdtempSync(join(tmpdir(), "agent-hands-teardown-"));
    const server = spawn(process.execPath, [entry], { env: { ...process.env, TMPDIR: tmp }, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const waiters = new Map<number, (m: any) => void>();
    server.stdout!.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {}
      }
    });
    let id = 0;
    const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
      const n = ++id;
      waiters.set(n, resolve);
      server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teardown-test", version: "0" } });
    server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = await request("tools/call", { name: "list_apps", arguments: {} });
    expect(result.result?.isError).not.toBe(true);
    const codex = Number(spawnSync("pgrep", ["-P", String(server.pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0]);
    expect(codex).toBeGreaterThan(0);
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    return { server, codex, tmp, exited };
  }

  const live = describe.runIf(process.platform === "darwin" && existsSync(CODEX_PATH));

  live("with a live desktop session", () => {
    it("exits and kills codex when stdin closes", async () => {
      const { server, codex, tmp, exited } = await startWithDesktopSession();
      server.stdin!.end();
      const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
      if (!done) server.kill("SIGKILL");
      expect(done).toBe(true);
      expect(await waitFor(() => !alive(codex))).toBe(true);
      rmSync(tmp, { recursive: true, force: true });
    }, 30_000);

    it("leaves no stopped codex behind when SIGKILL follows SIGTERM", async () => {
      const { server, codex, tmp } = await startWithDesktopSession();
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 600));
      server.kill("SIGKILL");
      const gone = await waitFor(() => !alive(codex), 3000);
      if (!gone) { try { process.kill(codex, "SIGCONT"); process.kill(codex, "SIGKILL"); } catch {} }
      expect(gone).toBe(true);
      rmSync(tmp, { recursive: true, force: true });
    }, 30_000);
  });
});
