import { describe, it, expect, vi } from "vitest";

// Mock all pipeline dependencies before importing the module.
vi.mock("../src/desktop/os/identity.js", () => ({
  resolveAppIdentity: vi.fn().mockResolvedValue({
    bundleId: "com.test.app",
    leaseId: "lease-test",
  }),
}));

vi.mock("../src/desktop/os/lock.js", () => ({
  acquireLock: vi.fn().mockResolvedValue({
    release: vi.fn().mockResolvedValue(undefined),
  }),
  AppBusyError: class extends Error {},
}));

vi.mock("../src/desktop/os/focus.js", () => ({
  startFocusTelemetry: vi.fn().mockReturnValue({
    stop: vi.fn(),
    finish: vi.fn().mockResolvedValue({
      backgroundPreserved: true,
      unrelatedFocusChanges: 0,
    }),
  }),
}));

vi.mock("../src/desktop/broker/verify.js", () => ({
  verifyBrokerComponents: vi.fn().mockResolvedValue({
    codexPath: "/fake/codex",
    codexVersion: "x".repeat(30 * 1024 * 1024), // 30 MB version string
    clientBuild: "test-build",
  }),
}));

vi.mock("../src/desktop/broker/dispatch.js", () => ({
  brokerDispatch: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "x".repeat(20 * 1024 * 1024) }],
    isError: false,
    modelTurnsStarted: 0,
    ephemeralThread: true,
    followUpResults: [],
  }),
}));

describe("executeBatchPipeline oversized fallback (mocked)", () => {
  it("returns bounded result without structuredContent when envelope exceeds 25 MB", async () => {
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");

    const ctx = {
      signal: new AbortController().signal,
      audit: vi.fn().mockResolvedValue(undefined),
      elicit: vi.fn().mockResolvedValue({ action: "approve" }),
    };

    const result = await executeBatchPipeline(
      "com.test.app",
      [{ method: "click", element_index: "1" }],
      false,
      ctx as any
    );

    // Must not have structuredContent (it would push past 25 MB).
    expect((result as any).structuredContent).toBeUndefined();
    expect(result.isError).toBe(true);

    // Content should be the minimal truncated batch response.
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.batch).toBe(true);
    expect(parsed.results).toEqual([]);
    expect(parsed.actions_returned).toBe(0);
    expect(parsed.truncated).toBe(true);

    // Envelope must be under 25 MB.
    const envelopeBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(envelopeBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    // And actually tiny.
    expect(envelopeBytes).toBeLessThan(1024);
  });
});
