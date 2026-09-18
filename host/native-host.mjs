#!/usr/bin/env node
import { createConnection, createServer } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MAX_EXTENSION_TO_HOST_BYTES = 64 * 1024 * 1024;
const MAX_HOST_TO_EXTENSION_BYTES = 1024 * 1024;
const socketPath = process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "agent-hands-browser.sock");
const controllerDirectory = process.env.AGENT_HANDS_BROWSER_CONTROLLER_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-hands", "browser-host.d");
const controllers = new Map();

function frame(value, maxBytes) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxBytes) throw new Error("Native messaging frame exceeds its allowed size.");
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function readFrames(stream, maxBytes, handler, onInvalid) {
  let buffered = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (size > maxBytes) throw new Error("Native messaging frame exceeds its allowed size.");
        if (buffered.length < size + 4) return;
        const body = buffered.subarray(4, size + 4);
        buffered = buffered.subarray(size + 4);
        handler(JSON.parse(body.toString("utf8")));
      }
    } catch { onInvalid(); }
  });
}

function sendNative(message) {
  try { process.stdout.write(frame(message, MAX_HOST_TO_EXTENSION_BYTES)); } catch { process.exit(1); }
}

function disconnectController(controllerId) {
  if (!controllers.delete(controllerId)) return;
  sendNative({ kind: "control", op: "disconnect", controllerId });
}

function authenticatedController(message) {
  if (message.kind !== "auth" || !/^[a-f0-9]{32}$/.test(message.controllerId ?? "") || typeof message.token !== "string") return false;
  try {
    const record = JSON.parse(readFileSync(join(controllerDirectory, `${message.controllerId}.json`), "utf8"));
    return typeof record.token === "string" && record.token === message.token;
  } catch {
    return false;
  }
}

async function activeBroker() {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

if (await activeBroker()) process.exit(0);
await rm(socketPath, { force: true });
const server = createServer((socket) => {
  let controllerId;
  readFrames(socket, MAX_EXTENSION_TO_HOST_BYTES, (message) => {
    if (!controllerId) {
      if (!authenticatedController(message) || controllers.has(message.controllerId)) return socket.destroy();
      controllerId = message.controllerId;
      controllers.set(controllerId, socket);
      socket.write(frame({ kind: "auth", controllerId, ok: true }, MAX_EXTENSION_TO_HOST_BYTES));
      return;
    }
    if (message.controllerId !== controllerId) return socket.destroy();
    sendNative(message);
  }, () => socket.destroy());
  socket.once("close", () => { if (controllerId) disconnectController(controllerId); });
});
server.once("error", () => process.exit(1));
server.once("close", () => { void rm(socketPath, { force: true }); });
server.listen(socketPath, async () => {
  try { await chmod(socketPath, 0o600); } catch { server.close(() => process.exit(1)); }
});

readFrames(process.stdin, MAX_EXTENSION_TO_HOST_BYTES, (message) => {
  if (typeof message.controllerId !== "string") return;
  const socket = controllers.get(message.controllerId);
  if (socket && !socket.destroyed) socket.write(frame(message, MAX_EXTENSION_TO_HOST_BYTES));
}, () => process.exit(1));
process.stdin.once("end", () => {
  for (const socket of controllers.values()) socket.destroy();
  controllers.clear();
  server.close(() => process.exit(0));
});
