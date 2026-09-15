#!/usr/bin/env node
// agent-hands: MCP server for macOS desktop control and Chrome browser control.

import { createServer } from "./kernel/index.js";
import { createDesktopSurface } from "./desktop/surface.js";
import { createBrowserSurface } from "./browser/surface.js";
import { buildStatus } from "./kernel/status.js";
import { browserHostStatus, installBrowserHost, uninstallBrowserHost, type BrowserSelection } from "./browser/host-installer.js";
import { runningVersion } from "./version.js";

const VERSION = runningVersion();

function buildSurfaces() {
  const enabled = (process.env.AGENT_HANDS_SURFACES ?? "desktop,browser")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const surfaces = [];
  if (enabled.includes("desktop")) surfaces.push(createDesktopSurface());
  if (enabled.includes("browser")) surfaces.push(createBrowserSurface());

  if (surfaces.length === 0) {
    throw new Error(
      `No surfaces enabled. AGENT_HANDS_SURFACES="${process.env.AGENT_HANDS_SURFACES}" ` +
      'must include "desktop" and/or "browser".'
    );
  }
  return surfaces;
}

async function main() {
  // CLI: --status prints status and exits.
  if (process.argv[2] === "--status") {
    const surfaces = buildSurfaces();
    const status = await buildStatus(surfaces, VERSION);
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    process.exit(0);
  }
  if (process.argv[2] === "install-browser-host") {
    const [extensionId, ...args] = process.argv.slice(3);
    const options = parseBrowserHostOptions(args, true);
    process.stdout.write(`${(await installBrowserHost({ ...options, extensionId })).join("\n")}\n`);
    return;
  }
  if (process.argv[2] === "uninstall-browser-host") {
    const options = parseBrowserHostOptions(process.argv.slice(3), false);
    process.stdout.write(`${(await uninstallBrowserHost(options)).join("\n")}\n`);
    return;
  }
  if (process.argv[2] === "browser-host-status") {
    if (process.argv.length > 3) throw new Error("Usage: agent-hands browser-host-status");
    const status = await browserHostStatus();
    process.stdout.write(`${status.lines.join("\n")}\n`);
    process.exitCode = status.healthy ? 0 : 1;
    return;
  }
  if (process.argv.length > 2) {
    process.stderr.write(`Unknown argument: ${process.argv[2]}\n`);
    process.exit(1);
  }

  const surfaces = buildSurfaces();
  const server = createServer(surfaces);

  const { closePool } = await import("./desktop/broker/dispatch.js");
  const shutdown = async () => {
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await server.run();
}

function parseBrowserHostOptions(args: string[], allowHostPath: boolean): { browser?: BrowserSelection; hostPath?: string } {
  let browser: BrowserSelection | undefined;
  let hostPath: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--browser") {
      if (!(["chrome", "brave", "edge", "chromium", "all"] as string[]).includes(value)) {
        throw new Error("--browser must be chrome, brave, edge, chromium, or all.");
      }
      browser = value as BrowserSelection;
    } else if (flag === "--host-path") {
      if (!allowHostPath) throw new Error(`Unknown argument: ${flag}`);
      hostPath = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return { browser, hostPath };
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
