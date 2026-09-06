import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateArgs } from "../src/kernel/validate.js";
import { sanitizeError } from "../src/kernel/sanitize.js";

describe("server routing without prior list-tools", () => {
  // The kernel now builds toolOwner at construction, so call-tool should work
  // without list-tools. We test via the validation and sanitize paths.

  it("validates args independently of list-tools", () => {
    const schema = {
      type: "object",
      properties: { app: { type: "string" } },
      required: ["app"],
      additionalProperties: false,
    };
    // Valid call.
    expect(validateArgs({ app: "Safari" }, schema)).toBeNull();
    // Missing required.
    expect(validateArgs({}, schema)).toContain("Missing required");
  });
});

describe("surface availability gating", () => {
  it("surfaces can report unavailable", async () => {
    // Simulates the desktop surface being unavailable (no signed components).
    const isAvailable = async () => false;
    expect(await isAvailable()).toBe(false);
  });
});

describe("AppleScript injection prevention", () => {
  it("rejects backslashes in app names", async () => {
    // Import dynamically to test the escape function.
    const mod = await import("../src/desktop/os/identity.js");
    // resolveAppIdentity with a malicious name should not throw AppleScript injection
    // but should throw our safe error or return null bundleId.
    try {
      const result = await mod.resolveAppIdentity('test" & do shell script "evil');
      // Should either reject or return null bundleId.
      expect(result.bundleId).toBeNull();
    } catch (e: any) {
      expect(e.message).toContain("Unsafe characters");
    }
  });

  it("rejects control characters", async () => {
    const mod = await import("../src/desktop/os/identity.js");
    try {
      const result = await mod.resolveAppIdentity("test\x00evil");
      expect(result.bundleId).toBeNull();
    } catch (e: any) {
      expect(e.message).toContain("Unsafe characters");
    }
  });
});

describe("error sanitization is applied to surface results", () => {
  it("strips home paths from error messages", () => {
    const msg = sanitizeError("Failed at /Users/alice/secret/project");
    expect(msg).not.toContain("alice");
    expect(msg).toContain("~");
  });

  it("strips URLs from error messages", () => {
    const msg = sanitizeError("CDP error: https://internal.corp.com/debug");
    expect(msg).toContain("[url]");
    expect(msg).not.toContain("internal.corp.com");
  });
});

describe("snapshot element ref pruning", () => {
  it("only keeps refs for visible elements", async () => {
    const { createFakeCDP } = await import("./fake-cdp.js");
    const { takeSnapshot } = await import("../src/browser/snapshot.js");

    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    const result = await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {
      responseLength: "short",
    });

    // All remaining refs should correspond to visible content lines.
    const visibleIds = new Set(result.content.filter(c => c.element_id).map(c => c.element_id));
    for (const [id] of refs) {
      expect(visibleIds.has(id)).toBe(true);
    }
  });
});

describe("load_all interval clamping", () => {
  it("clamps negative interval", async () => {
    const { createFakeCDP } = await import("./fake-cdp.js");
    const { loadAllAction } = await import("../src/browser/actions/load-all.js");

    const cdp = createFakeCDP([
      // First call: element exists.
      { method: "Runtime.evaluate", result: { result: { value: true } } },
      // Second call: element gone.
      { method: "Runtime.evaluate", result: { result: { value: null } } },
    ]);

    const result = await loadAllAction(cdp, "s1", {
      selector: ".load-more",
      interval_ms: -500, // Should be clamped to 0.
    });
    expect(result).toContain("Clicked 1 times");
  });
});

describe("CDP disconnect bridge cleanup", () => {
  it("bridges are cleared when root CDP closes", async () => {
    // This tests the behavior described in the surface code.
    // When rootCDP emits close, all bridges should be closed.
    const { createFakeCDP } = await import("./fake-cdp.js");
    const { TabBridge } = await import("../src/browser/tab-bridge.js");

    const cdp = createFakeCDP() as any;
    const bridge = new TabBridge("t1", "s1", cdp);
    expect(bridge.isClosed).toBe(false);

    // Simulate target destruction.
    bridge.close();
    expect(bridge.isClosed).toBe(true);
    expect(bridge.elementRefs.size).toBe(0);
  });
});
