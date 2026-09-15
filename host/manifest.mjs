#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST_NAME = "com.zmerchant.agenthands";

export function configDir() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-hands");
}

export function launcherPath() {
  return join(configDir(), "native-host-launcher");
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function launcherScript(nodePath, hostScript) {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(hostScript)} "$@"\n`;
}

export function manifestJson(launcher, extensionIds) {
  return {
    name: HOST_NAME,
    description: "agent-hands browser native host",
    path: launcher,
    type: "stdio",
    allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
  };
}

export async function writeLauncher(hostScript, nodePath = process.execPath) {
  const launcher = launcherPath();
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, launcherScript(nodePath, hostScript), { mode: 0o755 });
  await chmod(launcher, 0o755);
  return launcher;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1] === fileURLToPath(import.meta.url)) {
  const [hostScript, ...extensionIds] = process.argv.slice(2);

  if (!hostScript || !isAbsolute(hostScript) || extensionIds.length === 0) {
    throw new Error("Usage: node host/manifest.mjs /absolute/path/to/native-host.mjs extension-id [...extension-id]");
  }

  const launcher = await writeLauncher(hostScript);
  process.stdout.write(`${JSON.stringify(manifestJson(launcher, extensionIds), null, 2)}\n`);
}
