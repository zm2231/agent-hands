import { describe, expect, it, vi } from "vitest";

const IMAGE = { type: "image", data: "x".repeat(8 * 1024 * 1024), mimeType: "image/jpeg" };
const call = vi.fn(async (method: string) => ({
  content: [{ type: "text", text: `${method} tree` }, IMAGE],
  isError: false,
  modelTurnsStarted: 0,
  ephemeralThread: true,
  elicitationRequests: 0,
}));

vi.mock("../src/desktop/broker/pool.js", () => ({
  acquireSession: vi.fn(async () => ({
    session: { call, isAppActivated: () => true, markAppActivated: () => {} },
    release: () => {},
  })),
}));

describe("brokerDispatch image handling", () => {
  it("drops unrequested images before the aggregate budget so every tree survives", async () => {
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const followUpCalls = [1, 2, 3].map(() => ({ tool: "get_app_state", arguments: { app: "com.test.app" }, keepImages: false }));
    const result = await brokerDispatch({} as any, "get_app_state", { app: "com.test.app" }, { followUpCalls, keepImages: false });
    expect(result.content).toEqual([{ type: "text", text: "get_app_state tree" }]);
    expect(result.followUpResults!.map((r) => r.content)).toEqual(
      [1, 2, 3].map(() => [{ type: "text", text: "get_app_state tree" }])
    );
  });

  it("keeps requested images", async () => {
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const result = await brokerDispatch({} as any, "get_app_state", { app: "com.test.app" }, {
      followUpCalls: [{ tool: "click", arguments: { app: "com.test.app" }, keepImages: true }],
      keepImages: true,
    });
    expect(result.content).toContainEqual(IMAGE);
    expect(result.followUpResults![0].content).toContainEqual(IMAGE);
  });
});
