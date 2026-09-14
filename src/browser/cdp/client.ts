import type { CDPClient, CDPMessage, CDPTransport } from "./types.js";

const CDP_TIMEOUT_MS = 15_000;

export function createCDPClient(transport: CDPTransport): CDPClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();

  const rejectPending = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  transport.onMessage((message) => {
    if (message.id != null) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result ?? {});
      }
    }
    if (message.method) {
      for (const handler of listeners.get(message.method) ?? []) {
        handler(message.params ?? {}, message.sessionId);
      }
    }
  });

  transport.onClose(() => {
    if (closed) return;
    closed = true;
    rejectPending(new Error("CDP connection closed."));
    for (const handler of listeners.get("close") ?? []) handler({});
  });

  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error("CDP connection closed."));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method} after ${CDP_TIMEOUT_MS}ms`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
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
      if (closed) return;
      closed = true;
      transport.close();
      rejectPending(new Error("CDP connection closed."));
    },
  };
}
