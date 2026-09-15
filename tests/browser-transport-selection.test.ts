import { describe, expect, it, vi } from "vitest";
import { selectRootConnection } from "../src/browser/surface.js";
import type { CDPClient } from "../src/browser/cdp/types.js";

const tcpClient = {} as CDPClient;
const extensionClient = {} as CDPClient;

function deps(hasManifest: boolean, connectExtension: (timeoutMs: number) => Promise<{ client: CDPClient; close(): Promise<void> }>) {
  let tcpCalls = 0;
  return {
    hasManifest: async () => hasManifest,
    connectExtension,
    connectTcp: async () => {
      tcpCalls += 1;
      return tcpClient;
    },
    tcpCalls: () => tcpCalls,
  };
}

describe("browser transport selection", () => {
  it("uses TCP without creating an extension connection when no manifest exists", async () => {
    let extensionCalls = 0;
    const d = deps(false, async () => {
      extensionCalls += 1;
      return { client: extensionClient, close: async () => {} };
    });

    const selected = await selectRootConnection(undefined, d);

    expect(selected.client).toBe(tcpClient);
    expect(extensionCalls).toBe(0);
    expect(d.tcpCalls()).toBe(1);
  });

  it("uses the extension when a manifest exists and it connects during the auto probe", async () => {
    let timeout = 0;
    const d = deps(true, async (value) => {
      timeout = value;
      return { client: extensionClient, close: async () => {} };
    });

    const selected = await selectRootConnection(undefined, d);

    expect(selected.client).toBe(extensionClient);
    expect(timeout).toBe(3000);
    expect(d.tcpCalls()).toBe(0);
  });

  it("selects the extension after a pending maximum-backoff reconnect", async () => {
    vi.useFakeTimers();
    const d = deps(true, (timeout) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ client: extensionClient, close: async () => {} }), 2000);
      setTimeout(() => {
        clearTimeout(timer);
        reject(new Error("auto probe expired"));
      }, timeout);
    }));

    const selected = selectRootConnection(undefined, d);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(selected).resolves.toMatchObject({ client: extensionClient });
    expect(d.tcpCalls()).toBe(0);
    vi.useRealTimers();
  });

  it("falls back to TCP after an auto extension probe fails", async () => {
    const d = deps(true, async () => {
      throw new Error("extension unavailable");
    });

    const selected = await selectRootConnection(undefined, d);

    expect(selected.client).toBe(tcpClient);
    expect(d.tcpCalls()).toBe(1);
  });

  it("does not fall back from a forced extension connection", async () => {
    let timeout = 0;
    const d = deps(false, async (value) => {
      timeout = value;
      throw new Error("extension unavailable");
    });

    await expect(selectRootConnection("extension", d)).rejects.toThrow("extension unavailable");
    expect(timeout).toBe(60000);
    expect(d.tcpCalls()).toBe(0);
  });

  it("uses forced TCP without checking the extension", async () => {
    let extensionCalls = 0;
    const d = deps(true, async () => {
      extensionCalls += 1;
      return { client: extensionClient, close: async () => {} };
    });

    const selected = await selectRootConnection("tcp", d);

    expect(selected.client).toBe(tcpClient);
    expect(extensionCalls).toBe(0);
    expect(d.tcpCalls()).toBe(1);
  });
});
