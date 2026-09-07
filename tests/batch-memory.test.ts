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
    clientBuild: "test",
  }),
}));

// Mock dispatch: primary returns 5 MB, each of 19 follow-ups returns 5 MB.
// Without aggregate cap, total would be ~100 MB. With cap, only ~25 MB retained.
vi.mock("../src/desktop/broker/dispatch.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/desktop/broker/dispatch.js")>();
  return {
    ...mod,
    brokerDispatch: vi.fn().mockImplementation(
      async (_components: any, _method: string, _args: any, options: any) => {
        const bigContent = [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }];
        const followUpResults = (options?.followUpCalls ?? []).map((_fu: any, i: number) => {
          // After ~4 results (5 MB each = 25 MB), content should be omitted
          // But since this is the MOCK and not the real dispatch,
          // we need to test via the real dispatch's aggregate cap.
          // Actually, let me test differently — check content sizes in results.
          return {
            content: bigContent,
            isError: i === 18, // Last one has an error
            modelTurnsStarted: 0,
            ephemeralThread: true,
          };
        });
        return {
          content: bigContent,
          isError: false,
          modelTurnsStarted: 0,
          ephemeralThread: true,
          followUpResults,
        };
      }
    ),
  };
});

describe("batch aggregate memory bound (mocked)", () => {
  it("total retained content in pipeline result is bounded", async () => {
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");

    const actions = Array.from({ length: 20 }, () => ({ method: "get_app_state" }));
    const ctx = {
      signal: new AbortController().signal,
      audit: vi.fn().mockResolvedValue(undefined),
      elicit: vi.fn().mockResolvedValue({ action: "approve" }),
    };

    const result = await executeBatchPipeline("com.test.app", actions, true, ctx as any);

    // The response must be under 25 MB total.
    const responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(responseBytes).toBeLessThanOrEqual(25 * 1024 * 1024);

    // Execution count should reflect all 20 calls.
    const body = JSON.parse((result.content[0] as any).text);
    expect(body.actions_executed).toBe(20);

    // Error from the last follow-up should be preserved in the isError flag.
    expect(result.isError).toBe(true);
  });
});
