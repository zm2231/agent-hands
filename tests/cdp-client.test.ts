import { describe, expect, it } from "vitest";
import { createCDPClient } from "../src/browser/cdp/client.js";
import type { CDPMessage, CDPTransport } from "../src/browser/cdp/types.js";

class MemoryTransport implements CDPTransport {
  readonly sent: CDPMessage[] = [];
  private readonly messages = new Set<(message: CDPMessage) => void>();
  private readonly closes = new Set<() => void>();

  send(message: CDPMessage): void {
    this.sent.push(message);
  }

  onMessage(handler: (message: CDPMessage) => void): void {
    this.messages.add(handler);
  }

  onClose(handler: () => void): void {
    this.closes.add(handler);
  }

  close(): void {
    this.disconnect();
  }

  respond(message: CDPMessage): void {
    for (const handler of this.messages) handler(message);
  }

  disconnect(): void {
    for (const handler of this.closes) handler();
  }
}

describe("transport-agnostic CDP client", () => {
  it("routes session-scoped responses and events through an injected transport", async () => {
    const transport = new MemoryTransport();
    const client = createCDPClient(transport);
    const event = new Promise<{ params: Record<string, unknown>; sessionId?: string }>((resolve) => {
      client.on("Page.loadEventFired", (params, sessionId) => resolve({ params, sessionId }));
    });
    const response = client.send("Page.enable", {}, "claimed-tab");

    expect(transport.sent).toEqual([{ id: 1, method: "Page.enable", params: {}, sessionId: "claimed-tab" }]);
    transport.respond({ id: 1, result: { enabled: true } });
    transport.respond({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "claimed-tab" });

    await expect(response).resolves.toEqual({ enabled: true });
    await expect(event).resolves.toEqual({ params: { timestamp: 1 }, sessionId: "claimed-tab" });
  });

  it("rejects an in-flight request when its transport closes", async () => {
    const transport = new MemoryTransport();
    const client = createCDPClient(transport);
    const response = client.send("Page.enable");

    transport.disconnect();

    await expect(response).rejects.toThrow("CDP connection closed.");
  });
});
