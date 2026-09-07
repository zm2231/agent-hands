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
    content: [{ type: "text", text: "  Value: " + "x".repeat(5000) + "\n  [1] AXButton \"OK\"" }],
    isError: false,
    modelTurnsStarted: 0,
    ephemeralThread: true,
    followUpResults: [],
  }),
}));

describe("batch content handling", () => {
  it("caps AX tree values in get_app_state batch results", async () => {
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");

    const ctx = {
      signal: new AbortController().signal,
      audit: vi.fn().mockResolvedValue(undefined),
      elicit: vi.fn().mockResolvedValue({ action: "approve" }),
    };

    const result = await executeBatchPipeline(
      "com.test.app",
      [{ method: "get_app_state" }],
      false,
      ctx as any
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.batch).toBe(true);
    expect(parsed.results).toHaveLength(1);

    const treeText = parsed.results[0].content[0].text;
    expect(treeText).toContain("[5000 chars total]");
    expect(treeText).toContain("x".repeat(200));
    expect(treeText).not.toContain("x".repeat(201));
  });

  it("strips content from mutation batch results", async () => {
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

    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].content[0].text).toBe("click: ok");
  });
});
