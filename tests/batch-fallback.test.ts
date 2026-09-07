import { describe, it, expect, vi, beforeEach } from "vitest";
import { brokerDispatch } from "../src/desktop/broker/dispatch.js";

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

const mockDispatch = vi.fn();
vi.mock("../src/desktop/broker/dispatch.js", () => ({
  brokerDispatch: (...args: any[]) => mockDispatch(...args),
}));

describe("batch content handling", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
  });

  it("caps AX tree values in get_app_state batch results", async () => {
    mockDispatch.mockResolvedValue({
      content: [{ type: "text", text: "\t1 text Value: " + "x".repeat(5000) + "\n\t2 button OK" }],
      isError: false,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      followUpResults: [],
    });

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
    const treeText = parsed.results[0].content[0].text;
    expect(treeText).toContain("[5000 chars total]");
  });

  it("strips content from mutation batch results", async () => {
    mockDispatch.mockResolvedValue({
      content: [{ type: "text", text: "\t1 text Value: " + "x".repeat(5000) + "\n\t2 button OK" }],
      isError: false,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      followUpResults: [{
        content: [{ type: "text", text: "action done" }],
        isError: false,
        modelTurnsStarted: 0,
        ephemeralThread: true,
      }],
    });

    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const ctx = {
      signal: new AbortController().signal,
      audit: vi.fn().mockResolvedValue(undefined),
      elicit: vi.fn().mockResolvedValue({ action: "approve" }),
    };
    const result = await executeBatchPipeline(
      "com.test.app",
      [{ method: "get_app_state" }, { method: "click", element_index: "1" }],
      false,
      ctx as any
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[1].content[0].text).toBe("click: ok");
  });
});
