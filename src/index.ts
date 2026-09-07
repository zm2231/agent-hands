#!/usr/bin/env node
// agent-hands: MCP server for macOS desktop control and Chrome browser control.

import { createServer } from "./kernel/index.js";
import { createDesktopSurface } from "./desktop/surface.js";
import { createBrowserSurface } from "./browser/surface.js";
import { buildStatus } from "./kernel/status.js";

const VERSION = "0.1.0";

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

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
