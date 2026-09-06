#!/usr/bin/env node
// agent-hands: MCP server for macOS desktop control and Chrome browser control.

import { createServer } from "./kernel/index.js";
import { createDesktopSurface } from "./desktop/surface.js";
import { createBrowserSurface } from "./browser/surface.js";
import { buildStatus } from "./kernel/status.js";

const VERSION = "0.1.0";

async function main() {
  // CLI: --status prints status and exits.
  if (process.argv[2] === "--status") {
    const surfaces = [createDesktopSurface(), createBrowserSurface()];
    const status = await buildStatus(surfaces, VERSION);
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    process.exit(0);
  }
  if (process.argv.length > 2) {
    process.stderr.write(`Unknown argument: ${process.argv[2]}\n`);
    process.exit(1);
  }

  const surfaces = [createDesktopSurface(), createBrowserSurface()];
  const server = createServer(surfaces);
  await server.run();
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
