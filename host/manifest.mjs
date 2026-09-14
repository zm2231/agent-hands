#!/usr/bin/env node
import { isAbsolute } from "node:path";

const [path, ...extensionIds] = process.argv.slice(2);

if (!path || !isAbsolute(path) || extensionIds.length === 0) {
  throw new Error("Usage: node host/manifest.mjs /absolute/path/to/native-host.mjs extension-id [...extension-id]");
}

process.stdout.write(`${JSON.stringify({
  name: "com.zmerchant.agenthands",
  description: "agent-hands browser native host",
  path,
  type: "stdio",
  allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
}, null, 2)}\n`);
