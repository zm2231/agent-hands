#!/usr/bin/env node
import { createServer } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_EXTENSION_TO_HOST_BYTES = 64 * 1024 * 1024;
const MAX_HOST_TO_EXTENSION_BYTES = 1024 * 1024;
const socketPath = process.env.AGENT_HANDS_BROWSER_BROKER_SOCKET ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "agent-hands-browser.sock");
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

await rm(socketPath, { force: true });
const server = createServer((socket) => {
  let controllerId;
  readFrames(socket, MAX_EXTENSION_TO_HOST_BYTES, (message) => {
    if (!controllerId) {
      if (message.kind !== "auth" || typeof message.controllerId !== "string" || !message.controllerId || typeof message.token !== "string" || message.token.length < 32 || controllers.has(message.controllerId)) return socket.destroy();
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
server.listen(socketPath, async () => { await chmod(socketPath, 0o600); });

readFrames(process.stdin, MAX_EXTENSION_TO_HOST_BYTES, (message) => {
  if (typeof message.controllerId !== "string") return;
  const socket = controllers.get(message.controllerId);
  if (socket && !socket.destroyed) socket.write(frame(message, MAX_EXTENSION_TO_HOST_BYTES));
}, () => process.exit(1));
process.stdin.once("end", () => server.close(() => process.exit(0)));
