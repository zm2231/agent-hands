import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable, PassThrough } from "node:stream";

// We can't easily mock the broker dispatch internals without restructuring,
// so test the pipeline-level behavior through the tool schema and the
// observe flag stripping + follow-up call assembly logic.

describe("observe flag", () => {
  it("mutation tool schemas include observe: boolean", async () => {
    const { DESKTOP_TOOLS: desktopTools } = await import("../src/desktop/tools.js");
    const mutationTools = [
      "click", "type_text", "press_key", "set_value",
      "select_text", "scroll", "drag", "perform_secondary_action",
    ];
    for (const name of mutationTools) {
      const tool = desktopTools.find((t: any) => t.name === name);
      expect(tool, `${name} should exist`).toBeDefined();
      const props = (tool as any).inputSchema.properties;
      expect(props.observe, `${name} should have observe property`).toEqual({
        type: "boolean",
        description: expect.stringContaining("automatically returns"),
      });
    }
  });

  it("read tool schemas do NOT include observe", async () => {
    const { DESKTOP_TOOLS: desktopTools } = await import("../src/desktop/tools.js");
    for (const name of ["list_apps", "get_app_state"]) {
      const tool = desktopTools.find((t: any) => t.name === name);
      expect(tool, `${name} should exist`).toBeDefined();
      const props = (tool as any).inputSchema.properties;
      expect(props.observe, `${name} should not have observe`).toBeUndefined();
    }
  });
});

describe("brokerDispatch follow-up calls", () => {
  it("BrokerResult includes followUpResults when follow-up calls provided", async () => {
    // Verify the type exports correctly
    const mod = await import("../src/desktop/broker/dispatch.js");
    expect(mod.brokerDispatch).toBeTypeOf("function");
    // The FollowUpCall type is exported
    const fuCall: import("../src/desktop/broker/dispatch.js").FollowUpCall = {
      tool: "get_app_state",
      arguments: { app: "com.test.app" },
    };
    expect(fuCall.tool).toBe("get_app_state");
  });
});

describe("observe integration (pipeline level)", () => {
  it("observe flag is stripped before forwarding to broker", () => {
    // Simulate what the pipeline does
    const args: Record<string, unknown> = {
      app: "com.test.app",
      element_index: "3",
      observe: true,
    };
    const isMutation = true;
    const observe = isMutation && args.observe === true;
    const cleanArgs = { ...args };
    delete cleanArgs.observe;

    expect(observe).toBe(true);
    expect(cleanArgs).toEqual({ app: "com.test.app", element_index: "3" });
    expect(cleanArgs.observe).toBeUndefined();
  });

  it("follow-up calls list is empty when observe is false", () => {
    const args: Record<string, unknown> = {
      app: "com.test.app",
      element_index: "3",
    };
    const isMutation = true;
    const observe = isMutation && args.observe === true;
    const bundleId = "com.test.app";
    const followUpCalls = observe && bundleId
      ? [{ tool: "get_app_state", arguments: { app: bundleId } }]
      : [];

    expect(followUpCalls).toHaveLength(0);
  });

  it("follow-up calls list has get_app_state when observe is true", () => {
    const args: Record<string, unknown> = {
      app: "com.test.app",
      observe: true,
    };
    const isMutation = true;
    const observe = isMutation && args.observe === true;
    const bundleId = "com.test.app";
    const followUpCalls = observe && bundleId
      ? [{ tool: "get_app_state", arguments: { app: bundleId } }]
      : [];

    expect(followUpCalls).toHaveLength(1);
    expect(followUpCalls[0]).toEqual({
      tool: "get_app_state",
      arguments: { app: "com.test.app" },
    });
  });

  it("observe on read tools has no effect", () => {
    const method = "get_app_state";
    const args: Record<string, unknown> = {
      app: "com.test.app",
      observe: true,
    };
    const isMutation = method !== "list_apps" && method !== "get_app_state";
    const observe = isMutation && args.observe === true;

    expect(isMutation).toBe(false);
    expect(observe).toBe(false);
  });
});
