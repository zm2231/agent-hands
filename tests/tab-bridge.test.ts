import { describe, it, expect, vi } from "vitest";
import { TabBridge } from "../src/browser/tab-bridge.js";
import { createFakeCDP } from "./fake-cdp.js";

describe("TabBridge", () => {
  it("serializes operations on the same tab", async () => {
    const cdp = createFakeCDP();
    const order: number[] = [];
    const bridge = new TabBridge("t1", "s1", cdp);

    const p1 = bridge.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return 1;
    });
    const p2 = bridge.enqueue(async () => {
      order.push(2);
      return 2;
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
    bridge.close();
  });

  it("tracks closed state", () => {
    const cdp = createFakeCDP();
    const bridge = new TabBridge("t1", "s1", cdp);
    expect(bridge.isClosed).toBe(false);
    bridge.close();
    expect(bridge.isClosed).toBe(true);
  });

  it("clears element refs on close", () => {
    const cdp = createFakeCDP();
    const bridge = new TabBridge("t1", "s1", cdp);
    bridge.elementRefs.set(1, 100);
    bridge.close();
    expect(bridge.elementRefs.size).toBe(0);
  });
});
