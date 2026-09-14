import { describe, it, expect } from "vitest";
import { stripAuthChangeCapability, STRIP_CAPABILITY } from "../src/desktop/broker/cua-proxy-transform.js";

function initialize(experimental: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: { experimental } },
  });
}

describe("stripAuthChangeCapability", () => {
  it("removes codex/auth-change from an initialize request", () => {
    const out = JSON.parse(stripAuthChangeCapability(initialize({ [STRIP_CAPABILITY]: {} })));
    expect(out.params.capabilities.experimental[STRIP_CAPABILITY]).toBeUndefined();
  });

  it("preserves other experimental capabilities", () => {
    const out = JSON.parse(
      stripAuthChangeCapability(initialize({ [STRIP_CAPABILITY]: {}, "codex/other": { x: 1 } }))
    );
    expect(out.params.capabilities.experimental["codex/other"]).toEqual({ x: 1 });
    expect(out.params.capabilities.experimental[STRIP_CAPABILITY]).toBeUndefined();
  });

  it("leaves initialize without the capability unchanged", () => {
    const line = initialize({ "codex/other": {} });
    expect(stripAuthChangeCapability(line)).toBe(line);
  });

  it("passes non-initialize messages through untouched", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(stripAuthChangeCapability(line)).toBe(line);
  });

  it("passes a tool call carrying an auth-change-shaped argument through untouched", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "x", arguments: { capabilities: { experimental: { [STRIP_CAPABILITY]: {} } } } },
    });
    expect(stripAuthChangeCapability(line)).toBe(line);
  });

  it("passes malformed and blank lines through untouched", () => {
    expect(stripAuthChangeCapability("not json")).toBe("not json");
    expect(stripAuthChangeCapability("")).toBe("");
    expect(stripAuthChangeCapability("   ")).toBe("   ");
  });
});
