import { WebSocket } from "ws";
import { createCDPClient as createClient } from "./client.js";
import type { CDPClient, CDPMessage, CDPTransport } from "./types.js";

export function createCDPClient(wsUrl: string): Promise<CDPClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let closed = false;
    const messageHandlers = new Set<(message: CDPMessage) => void>();
    const closeHandlers = new Set<(error?: Error) => void>();

    const transport: CDPTransport = {
      send(message) { ws.send(JSON.stringify(message)); },
      onMessage(handler) { messageHandlers.add(handler); },
      onClose(handler) { closeHandlers.add(handler); },
      close() { ws.close(); },
    };

    ws.on("open", () => {
      resolve(createClient(transport));
    });

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as CDPMessage;
      for (const handler of messageHandlers) handler(message);
    });

    ws.on("error", (err) => {
      if (!closed) reject(err);
      for (const handler of closeHandlers) handler(err);
    });

    ws.on("close", () => {
      closed = true;
      for (const handler of closeHandlers) handler();
    });
  });
}
