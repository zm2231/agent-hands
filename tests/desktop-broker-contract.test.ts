import { beforeEach, describe, expect, it, vi } from "vitest";

const acquireSession = vi.fn();
vi.mock("../src/desktop/broker/pool.js", () => ({ acquireSession }));

describe("broker activation", () => {
  beforeEach(() => {
    acquireSession.mockReset();
  });

  it("does not dispatch a mutation when required activation fails", async () => {
    const calls = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "not active" }],
      structuredContent: {},
      isError: true,
      modelTurnsStarted: 0,
      ephemeralThread: true,
      elicitationRequests: 0,
    });
    const session = { isAppActivated: vi.fn().mockReturnValue(false), markAppActivated: vi.fn(), call: calls };
    acquireSession.mockResolvedValue({ session, release: vi.fn() });
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const result = await brokerDispatch({} as any, "click", { app: "com.test.app" }, { requireActivationFor: "com.test.app" });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledWith("get_app_state", { app: "com.test.app" }, expect.any(Object));
    expect(result.isError).toBe(true);
    expect(result.directCalls).toBe(1);
  });

  it("scopes activation to the acquired session", async () => {
    const session = {
      isAppActivated: vi.fn().mockReturnValue(false),
      markAppActivated: vi.fn(),
      call: vi.fn().mockResolvedValue({ content: [], structuredContent: {}, isError: false, modelTurnsStarted: 0, ephemeralThread: true, elicitationRequests: 0 }),
    };
    acquireSession.mockResolvedValue({ session, release: vi.fn() });
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const result = await brokerDispatch({} as any, "click", { app: "com.test.app" }, { requireActivationFor: "com.test.app" });
    expect(session.call.mock.calls.map(([method]: [string]) => method)).toEqual(["get_app_state", "click"]);
    expect(session.markAppActivated).toHaveBeenCalledWith("com.test.app");
    expect(result.directCalls).toBe(2);
  });
});
