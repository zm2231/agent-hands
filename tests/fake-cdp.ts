// Scripted fake CDP server for testing.

import type { CDPClient } from "../src/browser/cdp/types.js";

interface CannedResponse {
  method: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionFilter?: string;
}

export function createFakeCDP(canned: CannedResponse[] = []): CDPClient {
  const listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();
  const responses = [...canned];

  return {
    async send(method: string, params?: Record<string, unknown>, sessionId?: string) {
      const idx = responses.findIndex(
        (r) => r.method === method && (!r.sessionFilter || r.sessionFilter === sessionId)
      );
      if (idx !== -1) {
        const entry = responses[idx];
        responses.splice(idx, 1);
        if (entry.error) throw new Error(entry.error.message);
        return entry.result ?? {};
      }

      // Default responses for common methods.
      switch (method) {
        case "Target.getTargets":
          return {
            targetInfos: [
              {
                targetId: "ABCDEF1234567890",
                type: "page",
                title: "Test Page",
                url: "https://example.com",
              },
            ],
          };
        case "Target.attachToTarget":
          return { sessionId: "session-1" };
        case "Target.createTarget":
          return { targetId: "NEWPAGE1234567890" };
        case "Target.detachFromTarget":
          return {};
        case "Accessibility.getFullAXTree":
          return {
            nodes: [
              {
                nodeId: "1",
                role: { value: "button" },
                name: { value: "Click me" },
                value: { value: "" },
                backendDOMNodeId: 101,
              },
              {
                nodeId: "2",
                role: { value: "textbox" },
                name: { value: "Search" },
                value: { value: "" },
                backendDOMNodeId: 102,
              },
              {
                nodeId: "3",
                role: { value: "link" },
                name: { value: "Home" },
                value: { value: "" },
                backendDOMNodeId: 103,
              },
              {
                nodeId: "4",
                role: { value: "StaticText" },
                name: { value: "Hello world" },
                value: { value: "" },
              },
              {
                nodeId: "5",
                role: { value: "heading" },
                name: { value: "Welcome" },
                value: { value: "" },
              },
            ],
          };
        case "Runtime.evaluate":
          if (params?.expression?.toString().includes("document.title")) {
            return { result: { value: { title: "Test Page", url: "https://example.com" } } };
          }
          if (params?.expression?.toString().includes("devicePixelRatio")) {
            return { result: { value: 2 } };
          }
          if (params?.expression?.toString().includes("readyState")) {
            return { result: { value: "complete" } };
          }
          if (params?.expression?.toString().includes("activeElement")) {
            return { result: { value: { tag: "INPUT" } } };
          }
          return { result: { value: null } };
        case "Runtime.enable":
          return {};
        case "Runtime.callFunctionOn":
          return { result: { value: { cx: 100, cy: 50 } } };
        case "Runtime.releaseObject":
          return {};
        case "DOM.resolveNode":
          return { object: { objectId: "obj-1" } };
        case "DOM.getBoxModel":
          return { model: { border: [10, 10, 110, 10, 110, 60, 10, 60] } };
        case "Input.dispatchMouseEvent":
          return {};
        case "Input.insertText":
          return {};
        case "Page.enable":
          return {};
        case "Page.navigate":
          return { loaderId: "loader-1" };
        case "Page.captureScreenshot":
          return { data: Buffer.from("fake-png").toString("base64") };
        case "Page.getLayoutMetrics":
          return { layoutViewport: { clientWidth: 1920, clientHeight: 1080 } };
        default:
          return {};
      }
    },

    on(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },

    off(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void) {
      listeners.get(event)?.delete(handler);
    },

    close() {
      // Emit close event.
      const handlers = listeners.get("close");
      if (handlers) for (const h of handlers) h({});
    },

    // Test helpers.
    emit(event: string, params: Record<string, unknown>, sessionId?: string) {
      const handlers = listeners.get(event);
      if (handlers) for (const h of handlers) h(params, sessionId);
    },
  } as CDPClient & { emit: (event: string, params: Record<string, unknown>, sessionId?: string) => void };
}
