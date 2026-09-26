import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Resolver } from "../src/desktop/broker/dispatch.js";

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let stateIndex = 5n;

const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
  calls.push({ tool, args });
  const text = tool === "get_app_state" ? `\t${stateIndex} button Save` : `${tool} done`;
  if (tool !== "get_app_state") stateIndex++;
  return { content: [{ type: "text", text }], isError: false, modelTurnsStarted: 0, ephemeralThread: true, elicitationRequests: 0 };
});

vi.mock("../src/desktop/os/identity.js", () => ({
  resolveAppIdentity: vi.fn().mockResolvedValue({ bundleId: "com.test.app", leaseId: null }),
}));
vi.mock("../src/desktop/os/focus.js", () => ({
  startFocusTelemetry: vi.fn().mockReturnValue({ stop: vi.fn(), finish: vi.fn().mockResolvedValue({ backgroundPreserved: true, unrelatedFocusChanges: 0 }) }),
}));
vi.mock("../src/desktop/broker/verify.js", () => ({
  verifyBrokerComponents: vi.fn().mockResolvedValue({ codexVersion: "1.0.0", clientBuild: "test-build" }),
}));
vi.mock("../src/desktop/broker/pool.js", () => ({
  acquireSession: vi.fn(async () => ({
    session: { call, isAppActivated: () => true, markAppActivated: () => {} },
    release: () => {},
  })),
}));

const resolveSave: Resolver = (state, args) => {
  const match = /(\d+) button Save/.exec(state[0].text ?? "");
  if (!match) return { error: "no Save button" };
  const { target: _target, ...rest } = args;
  return { args: { ...rest, element_index: match[1] }, note: `${match[1]} button Save` };
};
const fail: Resolver = () => ({ error: "no match" });
const app = "com.test.app";

describe("brokerDispatch target resolution", () => {
  beforeEach(() => {
    calls.length = 0;
    stateIndex = 5n;
  });

  it("reads fresh state before a target action and forwards the resolved index without target", async () => {
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const result = await brokerDispatch({} as any, "click", { app, target: { name: "Save" } }, { resolve: resolveSave });
    expect(calls).toEqual([
      { tool: "get_app_state", args: { app } },
      { tool: "click", args: { app, element_index: "5" } },
    ]);
    expect(result.note).toBe("5 button Save");
    expect(result.directCalls).toBe(2);
  });

  it("reuses the preceding state read but re-reads after any other action", async () => {
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const result = await brokerDispatch({} as any, "get_app_state", { app }, {
      followUpCalls: [
        { tool: "click", arguments: { app, target: { name: "Save" } }, resolve: resolveSave },
        { tool: "click", arguments: { app, target: { name: "Save" } }, resolve: resolveSave },
      ],
    });
    expect(calls.map((c) => c.tool)).toEqual(["get_app_state", "click", "get_app_state", "click"]);
    expect(calls[1].args.element_index).toBe("5");
    expect(calls[3].args.element_index).toBe("6");
    expect(result.followUpResults!.map((r) => [r.note, r.directCalls])).toEqual([["5 button Save", 1], ["6 button Save", 2]]);
  });

  it("does not run an action whose target does not resolve, and stops the batch", async () => {
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    const result = await brokerDispatch({} as any, "get_app_state", { app }, {
      followUpCalls: [
        { tool: "click", arguments: { app, target: { name: "Nope" } }, resolve: fail },
        { tool: "press_key", arguments: { app, key: "Return" } },
      ],
    });
    expect(calls.map((c) => c.tool)).toEqual(["get_app_state"]);
    expect(result.followUpResults).toEqual([expect.objectContaining({ isError: true, content: [{ type: "text", text: "no match" }] })]);
  });

  it("continues past an unresolved target when continue_on_error is set", async () => {
    const { brokerDispatch } = await import("../src/desktop/broker/dispatch.js");
    await brokerDispatch({} as any, "get_app_state", { app }, {
      continueOnError: true,
      followUpCalls: [
        { tool: "click", arguments: { app, target: { name: "Nope" } }, resolve: fail },
        { tool: "press_key", arguments: { app, key: "Return" } },
      ],
    });
    expect(calls.map((c) => c.tool)).toEqual(["get_app_state", "press_key"]);
  });

  it("forwards large indexes exactly and audits every upstream call of a target batch", async () => {
    stateIndex = 9007199254740993n;
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const audit = vi.fn().mockResolvedValue(undefined);
    const result = await executeBatchPipeline("Test", [
      { method: "click", target: { name: "Save" } },
      { method: "click", target: { role: "button", name: "Save" } },
    ], false, { signal: new AbortController().signal, audit, elicit: vi.fn() } as any);
    expect(calls.map((c) => [c.tool, c.args.element_index])).toEqual([
      ["get_app_state", undefined],
      ["click", "9007199254740993"],
      ["get_app_state", undefined],
      ["click", "9007199254740994"],
    ]);
    expect(result.content).toEqual([{ type: "text", text: "#1 click: ok (9007199254740993 button Save)\n#2 click: ok (9007199254740994 button Save)" }]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ok", directCalls: 4, elicitationRequests: 0 }));
  });
});
