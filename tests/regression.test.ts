import { describe, it, expect } from "vitest";
import { TabBridge } from "../src/browser/tab-bridge.js";
import { createFakeCDP } from "./fake-cdp.js";

describe("TabBridge cleanup", () => {
  it("runs cleanup functions on close", () => {
    const cdp = createFakeCDP();
    const bridge = new TabBridge("t1", "s1", cdp);
    let cleaned = false;
    bridge.addCleanup(() => { cleaned = true; });
    bridge.close();
    expect(cleaned).toBe(true);
  });

  it("does not leak listeners across open/close cycles", () => {
    const cdp = createFakeCDP() as any;
    const listeners: Array<() => void> = [];
    const origOn = cdp.on.bind(cdp);
    const origOff = cdp.off.bind(cdp);
    let addCount = 0;
    let removeCount = 0;

    cdp.on = (event: string, handler: any) => {
      addCount++;
      listeners.push(handler);
      origOn(event, handler);
    };
    cdp.off = (event: string, handler: any) => {
      removeCount++;
      origOff(event, handler);
    };

    // Simulate 3 open/close cycles.
    for (let i = 0; i < 3; i++) {
      const bridge = new TabBridge(`t${i}`, `s${i}`, cdp);
      const handler1 = () => bridge.close();
      const handler2 = () => bridge.close();
      cdp.on("Target.targetDestroyed", handler1);
      cdp.on("Target.detachedFromTarget", handler2);
      bridge.addCleanup(() => {
        cdp.off("Target.targetDestroyed", handler1);
        cdp.off("Target.detachedFromTarget", handler2);
      });
      bridge.close();
    }

    // Every added listener should have been removed.
    expect(removeCount).toBe(addCount);
  });
});

describe("snapshot metadata byte budget", () => {
  it("caps metadata with control characters under budget", async () => {
    const { createFakeCDP } = await import("./fake-cdp.js");
    const { takeSnapshot } = await import("../src/browser/snapshot.js");

    // Create a fake CDP that returns a URL full of control chars.
    const controlUrl = "\u0001".repeat(8000);
    const cdp = createFakeCDP([
      {
        method: "Runtime.evaluate",
        result: { result: { value: { title: "Test", url: controlUrl } } },
      },
    ]);
    const refs = new Map<number, number>();
    const result = await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {});
    const serialized = JSON.stringify(result);
    const byteSize = Buffer.byteLength(serialized, "utf8");
    expect(byteSize).toBeLessThanOrEqual(38_000);
  });
});

describe("readResult offset validation", () => {
  it("rejects negative offset", async () => {
    const { storeText, readResult } = await import("../src/browser/artifacts.js");
    const bigText = "x".repeat(50_000);
    const stored = await storeText(bigText);
    await expect(readResult(stored.handle!, -1)).rejects.toThrow("non-negative integer");
  });

  it("rejects fractional offset", async () => {
    const { storeText, readResult } = await import("../src/browser/artifacts.js");
    const bigText = "x".repeat(50_000);
    const stored = await storeText(bigText);
    await expect(readResult(stored.handle!, 1.5)).rejects.toThrow("non-negative integer");
  });
});
