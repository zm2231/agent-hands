#!/usr/bin/env node
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_EXTENSION_TO_HOST_BYTES = 1024 * 1024;
const MAX_HOST_TO_EXTENSION_BYTES = 64 * 1024 * 1024;

function frame(value, maxBytes) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxBytes) throw new Error("Native messaging frame exceeds its allowed size.");
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function readFrames(stream, maxBytes, handler) {
  let buffered = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32LE(0);
      if (size > maxBytes) throw new Error("Native messaging frame exceeds its allowed size.");
      if (buffered.length < size + 4) return;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      handler(JSON.parse(body.toString("utf8")));
    }
  });
}

const configPath = process.env.AGENT_HANDS_NATIVE_HOST_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-hands", "browser-host.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const socket = createConnection(config.socketPath);
socket.once("connect", () => socket.write(frame({ kind: "auth", token: config.token }, MAX_EXTENSION_TO_HOST_BYTES)));
socket.once("error", () => process.exit(1));
socket.once("close", () => process.exit(0));
readFrames(process.stdin, MAX_EXTENSION_TO_HOST_BYTES, (message) => socket.write(frame(message, MAX_EXTENSION_TO_HOST_BYTES)));
readFrames(socket, MAX_HOST_TO_EXTENSION_BYTES, (message) => process.stdout.write(frame(message, MAX_HOST_TO_EXTENSION_BYTES)));
