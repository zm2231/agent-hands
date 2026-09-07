import { describe, it, expect, vi } from "vitest";

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
    codexVersion: "1.0.0",
    clientBuild: "test-build",
  }),
}));

vi.mock("../src/desktop/broker/dispatch.js", () => ({
  brokerDispatch: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "x".repeat(26 * 1024 * 1024) }],
    isError: false,
    modelTurnsStarted: 0,
    ephemeralThread: true,
    followUpResults: [],
  }),
}));

describe("executeBatchPipeline oversized fallback (mocked)", () => {
  it("truncates oversized results and stays within 25 MB", async () => {
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

    // No structuredContent in the response.
    expect((result as any).structuredContent).toBeUndefined();

    // Content should be the truncated batch response.
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.batch).toBe(true);
    expect(parsed.results).toEqual([]);
    expect(parsed.actions_returned).toBe(0);
    expect(parsed.truncated).toBe(true);
    expect(parsed.actions_executed).toBe(1);

    // Envelope must be under 25 MB and actually tiny.
    const envelopeBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(envelopeBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(envelopeBytes).toBeLessThan(1024);
  });
});
