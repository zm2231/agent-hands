// Production CDP transport over WebSocket.

import { WebSocket } from "ws";
import type { CDPClient } from "./types.js";

const CDP_TIMEOUT_MS = 15_000;

export function createCDPClient(wsUrl: string): Promise<CDPClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();
    let closed = false;

    ws.on("open", () => {
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const msg: Record<string, unknown> = { id, method, params };
            if (sessionId) msg.sessionId = sessionId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method} after ${CDP_TIMEOUT_MS}ms`));
            }, CDP_TIMEOUT_MS);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify(msg));
          });
        },
        on(event, handler) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(handler);
        },
        off(event, handler) {
          listeners.get(event)?.delete(handler);
        },
        close() {
          closed = true;
          ws.close();
        },
      });
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result ?? {});
        }
      }
      if (msg.method) {
        const handlers = listeners.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params ?? {}, msg.sessionId);
        }
      }
    });

    ws.on("error", (err) => {
      if (!closed) reject(err);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      pending.clear();
    });

    ws.on("close", () => {
      closed = true;
      const handlers = listeners.get("close");
      if (handlers) for (const h of handlers) h({});
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP connection closed."));
      }
      pending.clear();
    });
  });
}
