import { beforeEach, describe, expect, it, vi } from "vitest";

const brokerDispatch = vi.fn();

vi.mock("../src/desktop/os/identity.js", () => ({
  resolveAppIdentity: vi.fn().mockResolvedValue({ bundleId: "com.test.app", leaseId: null }),
}));
vi.mock("../src/desktop/os/focus.js", () => ({
  startFocusTelemetry: vi.fn().mockReturnValue({ stop: vi.fn(), finish: vi.fn().mockResolvedValue({ backgroundPreserved: true, unrelatedFocusChanges: 0 }) }),
}));
vi.mock("../src/desktop/broker/verify.js", () => ({
  verifyBrokerComponents: vi.fn().mockResolvedValue({ codexVersion: "1.0.0", clientBuild: "test-build" }),
}));
vi.mock("../src/desktop/broker/dispatch.js", () => ({ brokerDispatch }));

describe("desktop pipeline MCP response", () => {
  beforeEach(() => {
    brokerDispatch.mockReset();
    brokerDispatch.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      directCalls: 2,
      elicitationRequests: 1,
      followUpResults: [],
    });
  });

  it("returns native-compatible execution metadata as structuredContent", async () => {
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const audit = vi.fn().mockResolvedValue(undefined);
    const result = await executePipeline("click", { app: "Test", element_index: "1" }, {
      signal: new AbortController().signal,
      audit,
      elicit: vi.fn().mockResolvedValue({ action: "accept" }),
    } as any);
    expect(result.structuredContent).toMatchObject({
      method: "click",
      app: "com.test.app",
      directCalls: 2,
      modelTurnsStarted: 0,
      ephemeralRuntimeContext: true,
      elicitationRequests: 1,
      brokerVersion: "1.0.0",
      clientBuild: "test-build",
      backgroundPreserved: true,
      brokerCleanupVerified: true,
    });
    expect((result.structuredContent as any).ephemeralThread).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ directCalls: 2, elicitationRequests: 1 }));
  });
});
