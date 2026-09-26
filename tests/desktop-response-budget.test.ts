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

const TREE = "<app_state>\n0 standard window Test\n\t1 button OK\n</app_state>";
const IMAGE = { type: "image", data: "aW1n", mimeType: "image/jpeg" };
const state = () => [{ type: "text", text: TREE }, IMAGE];

function brokerResult(content: any[], followUpResults: any[] = [], isError = false) {
  const keep = (blocks: any[], flag: boolean | undefined) => flag === false ? blocks.filter((b) => b.type !== "image") : blocks;
  return (_components?: unknown, _method?: string, _args?: unknown, options: any = {}) => ({
    content: keep(content, options.keepImages),
    isError,
    modelTurnsStarted: 0,
    ephemeralThread: true,
    directCalls: 1 + followUpResults.length,
    elicitationRequests: 0,
    followUpResults: followUpResults.map((fu, i) => ({ ...fu, content: keep(fu.content, options.followUpCalls?.[i]?.keepImages) })),
  });
}

function ctx() {
  return {
    signal: new AbortController().signal,
    audit: vi.fn().mockResolvedValue(undefined),
    elicit: vi.fn().mockResolvedValue({ action: "accept" }),
  } as any;
}

const STATE_TOOLS = ["get_app_state", "click", "type_text", "press_key", "set_value", "select_text", "scroll", "drag", "perform_secondary_action"];

describe("desktop tool schemas", () => {
  it("offers screenshot opt-in on every state-returning tool and no observe flag", async () => {
    const { DESKTOP_TOOLS } = await import("../src/desktop/tools.js");
    for (const name of STATE_TOOLS) {
      const props = (DESKTOP_TOOLS.find((t) => t.name === name)!.inputSchema as any).properties;
      expect(props.screenshot?.type, name).toBe("boolean");
      expect(props.observe, name).toBeUndefined();
    }
    const listApps = (DESKTOP_TOOLS.find((t) => t.name === "list_apps")!.inputSchema as any).properties;
    expect(listApps.screenshot).toBeUndefined();
  });
});

describe("single-call responses", () => {
  beforeEach(() => brokerDispatch.mockReset());

  it.each(["get_app_state", "click"])("%s drops screenshots and metadata by default", async (method) => {
    brokerDispatch.mockImplementation(brokerResult(state()));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const result = await executePipeline(method, { app: "Test", element_index: "1" }, ctx());
    expect(result.content).toEqual([{ type: "text", text: TREE }]);
    expect(result.structuredContent).toBeUndefined();
    expect(brokerDispatch.mock.calls[0][3].keepImages).toBe(false);
  });

  it("returns the screenshot when requested and never forwards the flag upstream", async () => {
    brokerDispatch.mockImplementation(brokerResult(state()));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const result = await executePipeline("get_app_state", { app: "Test", screenshot: true }, ctx());
    expect(result.content).toEqual(state());
    expect(brokerDispatch.mock.calls[0][2]).toEqual({ app: "com.test.app" });
  });

  it("records execution metadata in the audit log instead of the response", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: "ok" }]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const context = ctx();
    const result = await executePipeline("click", { app: "Test", element_index: "1" }, context);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(context.audit).toHaveBeenCalledWith(expect.objectContaining({
      method: "click",
      outcome: "ok",
      brokerVersion: "1.0.0",
      ephemeralRuntimeContext: true,
      backgroundPreserved: true,
      unrelatedFocusChanges: 0,
    }));
  });
});

describe("batch responses", () => {
  beforeEach(() => brokerDispatch.mockReset());

  async function runBatch(actions: any[], continueOnError = false) {
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    return executeBatchPipeline("Test", actions, continueOnError, ctx());
  }

  it("records execution metadata in the audit log", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [{ content: state(), isError: false }]));
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const context = ctx();
    await executeBatchPipeline("Test", [{ method: "click", element_index: "1" }], false, context);
    expect(context.audit).toHaveBeenCalledWith(expect.objectContaining({
      method: "desktop_batch",
      outcome: "ok",
      directCalls: 2,
      brokerVersion: "1.0.0",
      ephemeralRuntimeContext: true,
      backgroundPreserved: true,
      unrelatedFocusChanges: 0,
    }));
  });

  it("runs implicit activation without returning its state", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [
      { content: state(), isError: false },
      { content: state(), isError: false },
    ]));
    const result = await runBatch([{ method: "click", element_index: "1" }, { method: "press_key", key: "Return" }]);
    const [, method, , options] = brokerDispatch.mock.calls[0];
    expect(method).toBe("get_app_state");
    expect(options.followUpCalls.map((c: any) => c.tool)).toEqual(["click", "press_key"]);
    expect(result.content).toEqual([{ type: "text", text: "#1 click: ok\n#2 press_key: ok" }]);
    expect(result.isError).toBe(false);
  });

  it("returns explicit state as raw text with images only on request", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [
      { content: state(), isError: false },
      { content: state(), isError: false },
    ]));
    const result = await runBatch([
      { method: "get_app_state" },
      { method: "click", element_index: "1" },
      { method: "get_app_state", screenshot: true },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: `#1 get_app_state\n${TREE}\n#2 click: ok\n#3 get_app_state\n${TREE}` },
      IMAGE,
    ]);
    const forwarded = brokerDispatch.mock.calls[0][3].followUpCalls[1].arguments;
    expect(forwarded).toEqual({ app: "com.test.app" });
  });

  it("caps AX tree values in batch state", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: "\t1 text Value: " + "x".repeat(5000) + "\n\t2 button OK" }]));
    const result = await runBatch([{ method: "get_app_state" }]);
    expect((result.content[0] as any).text).toContain("[5000 chars total]");
  });

  it("returns the first action's requested screenshot when implicit activation fails", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: "app not running" }, IMAGE], [], true));
    const result = await runBatch([{ method: "click", element_index: "1", screenshot: true }]);
    expect(brokerDispatch.mock.calls[0][3].keepImages).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "activation: error\napp not running" },
      IMAGE,
      { type: "text", text: "stopped: 0 of 1 actions ran" },
    ]);
  });

  it("surfaces a failed activation and reports that nothing ran", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: "app not running" }], [], true));
    const result = await runBatch([{ method: "click", element_index: "1" }]);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "activation: error\napp not running\nstopped: 0 of 1 actions ran" }]);
  });

  it("reports a fail-stop error and the actions that did not run", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [
      { content: state(), isError: false },
      { content: [{ type: "text", text: "no such element" }], isError: true },
    ]));
    const result = await runBatch([
      { method: "click", element_index: "1" },
      { method: "click", element_index: "99" },
      { method: "press_key", key: "Return" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "#1 click: ok\n#2 click: error\nno such element\nstopped: 2 of 3 actions ran" }]);
  });

  it("returns requested screenshots on mutation and error results", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [
      { content: state(), isError: false },
      { content: [{ type: "text", text: "no such element" }, IMAGE], isError: true },
    ]));
    const result = await runBatch([
      { method: "click", element_index: "1", screenshot: true },
      { method: "click", element_index: "99", screenshot: true },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "#1 click: ok" },
      IMAGE,
      { type: "text", text: "#2 click: error\nno such element" },
      IMAGE,
    ]);
  });

  it("forwards only upstream arguments, normalized, with continue_on_error", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [{ content: state(), isError: false }]));
    await runBatch([{ method: "get_app_state", screenshot: true }, { method: "press_key", key: "enter" }], true);
    const [, method, args, options] = brokerDispatch.mock.calls[0];
    expect(method).toBe("get_app_state");
    expect(args).toEqual({ app: "com.test.app" });
    expect(options.keepImages).toBe(true);
    expect(options.followUpCalls).toEqual([{ tool: "press_key", arguments: { app: "com.test.app", key: "Return" }, keepImages: false }]);
    expect(options.continueOnError).toBe(true);
  });

  it.each([
    [{ method: "click", element_index: "1", observe: true }, "Unknown argument(s): observe"],
    [{ method: "press_key" }, "Missing required argument: key"],
    [{ method: "list_apps" }, 'Invalid batch method "list_apps"'],
    [{ method: "click", app: "Other", element_index: "1" }, "app is set once for the whole batch"],
  ])("rejects %o before dispatch", async (action, message) => {
    const result = await runBatch([action]);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(message);
    expect(brokerDispatch).not.toHaveBeenCalled();
  });

  it("keeps the serialized response within 25 MB for escape-heavy state", async () => {
    const { renderBatch } = await import("../src/desktop/pipeline.js");
    const quoted = { type: "text", text: '"'.repeat(20 * 1024 * 1024) } as const;
    const executed = [0, 1].map(() => ({ method: "get_app_state", content: [quoted], isError: false }));
    const content = renderBatch(executed, false, 2);
    expect(Buffer.byteLength(JSON.stringify({ content, isError: false }), "utf8")).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(content.map((b) => b.text).join("\n")).toContain("#1 get_app_state: output omitted (response size limit)");
  });
});
