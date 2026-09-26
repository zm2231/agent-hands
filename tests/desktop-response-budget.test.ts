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
  return (_components: unknown, _method: string, _args: unknown, options: any) => ({
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
  beforeEach(() => {
    brokerDispatch.mockReset();
  });

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
  beforeEach(() => {
    brokerDispatch.mockReset();
  });

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

describe("targets and find", () => {
  beforeEach(() => {
    brokerDispatch.mockReset();
  });

  const RIBBON = "<app_state>\n0 standard window Doc\n\t1 container Status Bar\n\t\t2 button Zoom Out\n\t\t3 button Zoom In\n\t4 toggle button Bold, Value: off\n</app_state>";

  it("offers target on element tools without requiring element_index, and find on get_app_state", async () => {
    const { DESKTOP_TOOLS } = await import("../src/desktop/tools.js");
    for (const name of ["click", "set_value", "select_text", "scroll", "perform_secondary_action"]) {
      const schema = DESKTOP_TOOLS.find((t) => t.name === name)!.inputSchema as any;
      expect(schema.properties.target?.required, name).toEqual(["name"]);
      expect(schema.required, name).not.toContain("element_index");
    }
    const state = DESKTOP_TOOLS.find((t) => t.name === "get_app_state")!.inputSchema as any;
    expect(state.properties.find.type).toBe("string");
  });

  it("resolves a single-call target against the state the broker reads and returns a one-line receipt", async () => {
    brokerDispatch.mockImplementation(async (_c: unknown, _m: string, args: any, options: any) => {
      const resolved = options.resolve([{ type: "text", text: RIBBON }], args);
      return { ...brokerResult([{ type: "text", text: "full tree after click" }, IMAGE])(_c, _m, resolved.args, options), note: resolved.note, forwarded: resolved.args };
    });
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const result = await executePipeline("click", { app: "Test", target: { name: "Bold" } }, ctx());
    expect(result.content).toEqual([{ type: "text", text: "click: ok (4 toggle button Bold, Value: off)" }]);
    const forwarded = await brokerDispatch.mock.results[0].value;
    expect(forwarded.forwarded).toEqual({ app: "com.test.app", element_index: "4" });
  });

  it("returns only matching elements for get_app_state find", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: RIBBON }, IMAGE]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const result = await executePipeline("get_app_state", { app: "Test", find: "zoom" }, ctx());
    expect(result.content).toEqual([{ type: "text", text: 'find "zoom": 2 of 5 elements\n2 button Zoom Out  [container Status Bar]\n3 button Zoom In  [container Status Bar]' }]);
    expect(brokerDispatch.mock.calls[0][2]).toEqual({ app: "com.test.app" });
  });

  it.each([
    ["click", { target: { name: "Bold" }, element_index: "4" }, "Pass target or element_index/coordinates, not both."],
    ["click", { target: { name: "Bold" }, x: 1, y: 2 }, "Pass target or element_index/coordinates, not both."],
    ["scroll", { direction: "down" }, "scroll needs element_index or target."],
    ["click", { target: { name: "Bold", fuzzy: true } }, "Unknown target field(s): fuzzy"],
    ["get_app_state", { find: "  " }, "find must be a non-empty string."],
  ])("rejects %s %o before dispatch", async (method, extra, message) => {
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const result = await executePipeline(method, { app: "Test", ...extra }, ctx());
    expect(result).toEqual({ content: [{ type: "text", text: message }], isError: true });
    expect(brokerDispatch).not.toHaveBeenCalled();
  });

  it("passes batch target resolvers per action and renders receipts and find results", async () => {
    brokerDispatch.mockImplementation(brokerResult(state(), [
      { content: state(), isError: false, note: "4 toggle button Bold, Value: off" },
      { content: [{ type: "text", text: RIBBON }], isError: false },
    ]));
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const result = await executeBatchPipeline("Test", [
      { method: "click", target: { name: "Bold" } },
      { method: "get_app_state", find: "zoom in" },
    ], false, ctx());
    const followUps = brokerDispatch.mock.calls[0][3].followUpCalls;
    expect(typeof followUps[0].resolve).toBe("function");
    expect(followUps[0].arguments).toEqual({ app: "com.test.app", target: { name: "Bold" } });
    expect(followUps[1].resolve).toBeUndefined();
    expect(followUps[1].arguments).toEqual({ app: "com.test.app" });
    expect(result.content).toEqual([{ type: "text", text: '#1 click: ok (4 toggle button Bold, Value: off)\n#2 get_app_state\nfind "zoom in": 1 of 5 elements\n3 button Zoom In  [container Status Bar]' }]);
  });

  it("rejects an invalid batch target before dispatch", async () => {
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const result = await executeBatchPipeline("Test", [{ method: "press_key", key: "a", target: { name: "x" } }], false, ctx());
    expect((result.content[0] as any).text).toBe("Batch action #1 (press_key): Unknown argument(s): target");
    expect(brokerDispatch).not.toHaveBeenCalled();
  });
});

describe("compact view", () => {
  beforeEach(() => {
    brokerDispatch.mockReset();
  });

  const BIG = ["<app_state>", "0 standard window Doc", "\t1 group Items", ...Array.from({ length: 500 }, (_, i) => `\t\t${i + 2} button Item ${i}`), "</app_state>"].join("\n");

  it("returns large trees compact by default and complete with full", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: BIG }]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const compact = (await executePipeline("get_app_state", { app: "Test" }, ctx())).content[0] as any;
    expect(compact.text).toMatch(/^\[AX tree trimmed: \d+ -> \d+ chars\. \d+ of 502 elements shown;/);
    expect(compact.text.length).toBeLessThan(5600);
    expect(compact.text).toMatch(/\t\t… \d+ more: Item \d+, /);
    const full = (await executePipeline("get_app_state", { app: "Test", full: true }, ctx())).content[0] as any;
    expect(full.text).toBe(BIG);
    expect(brokerDispatch.mock.calls[1][2]).toEqual({ app: "com.test.app" });
  });

  it("saves trees over the file threshold in full and names the file in the compact header", async () => {
    const huge = ["<app_state>", "0 standard window Doc", "\t1 group Items", ...Array.from({ length: 4000 }, (_, i) => `\t\t${i + 2} button Item ${i}`), "</app_state>"].join("\n");
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: huge }]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const text = ((await executePipeline("get_app_state", { app: "Test" }, ctx())).content[0] as any).text as string;
    const path = /Full tree saved to (\S+)\]/.exec(text)![1];
    expect(text).toMatch(/elements shown;/);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf8")).toBe(huge);
  });

  it("returns the tree after a mutation compact as well", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: BIG }]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const text = ((await executePipeline("click", { app: "Test", element_index: "5" }, ctx())).content[0] as any).text as string;
    expect(text).toMatch(/of 502 elements shown;/);
    expect(text.length).toBeLessThan(5600);
  });

  it("leaves small trees unchanged", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: TREE }]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    expect((await executePipeline("get_app_state", { app: "Test" }, ctx())).content).toEqual([{ type: "text", text: TREE }]);
  });

  it.each([
    ["get_app_state", { find: "x", full: true }, "Pass find or full, not both."],
    ["get_app_state", { full: "yes" }, "full must be a boolean."],
    ["click", { element_index: "1", full: true }, "click does not accept full."],
  ])("rejects %s %o before dispatch", async (method, extra, message) => {
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const result = await executePipeline(method, { app: "Test", ...extra }, ctx());
    expect(result).toEqual({ content: [{ type: "text", text: message }], isError: true });
    expect(brokerDispatch).not.toHaveBeenCalled();
  });

  it("applies the compact view per batch action unless full is set", async () => {
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: BIG }], [{ content: [{ type: "text", text: BIG }], isError: false }]));
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const result = await executeBatchPipeline("Test", [{ method: "get_app_state" }, { method: "get_app_state", full: true }], false, ctx());
    expect(brokerDispatch.mock.calls[0][3].followUpCalls[0].arguments).toEqual({ app: "com.test.app" });
    const [first, second] = ((result.content[0] as any).text as string).split("\n#2 get_app_state\n");
    expect(first).toMatch(/^#1 get_app_state\n\[AX tree trimmed: .* of 502 elements shown;/);
    expect(second).toBe(BIG);
  });
});

describe("app instructions", () => {
  beforeEach(() => {
    brokerDispatch.mockReset();
  });

  const withInstructions = (body: string) =>
    ["<app_specific_instructions>", "## Test Computer Use", body, "</app_specific_instructions>", TREE].join("\n");
  const POINTER = "[Test Computer Use: app instructions shown under a minute ago; pass instructions: true to include them again]";

  it("shows app instructions once, then a pointer, and again on request", async () => {
    const text = withInstructions("Use the toolbar.");
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text }]));
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    const read = async (extra: Record<string, unknown> = {}) => ((await executePipeline("get_app_state", { app: "Test", ...extra }, ctx())).content[0] as any).text;
    expect(await read()).toBe(text);
    expect(await read()).toBe(`${POINTER}\n${TREE}`);
    expect(await read({ instructions: true })).toBe(text);
    expect(brokerDispatch.mock.calls[2][2]).toEqual({ app: "com.test.app" });
  });

  it("applies the same rule inside a batch", async () => {
    const text = withInstructions("Use the menu bar.");
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text }], [
      { content: [{ type: "text", text }], isError: false },
      { content: [{ type: "text", text }], isError: false },
    ]));
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const result = await executeBatchPipeline("Test", [
      { method: "get_app_state" },
      { method: "get_app_state" },
      { method: "get_app_state", instructions: true },
    ], false, ctx());
    expect((result.content[0] as any).text).toBe([`#1 get_app_state\n${text}`, `#2 get_app_state\n${POINTER}\n${TREE}`, `#3 get_app_state\n${text}`].join("\n"));
    expect(brokerDispatch.mock.calls[0][3].followUpCalls[1].arguments).toEqual({ app: "com.test.app" });
  });

  it("keeps showing instructions whose batch output was omitted for size", async () => {
    const text = withInstructions("Use the dock.");
    const huge = `${text}\n${"x".repeat(26 * 1024 * 1024)}`;
    brokerDispatch.mockImplementation(brokerResult([{ type: "text", text: huge }], [{ content: [{ type: "text", text }], isError: false }]));
    const { executeBatchPipeline } = await import("../src/desktop/pipeline.js");
    const result = await executeBatchPipeline("Test", [{ method: "get_app_state" }, { method: "get_app_state" }], false, ctx());
    const out = (result.content[0] as any).text as string;
    expect(out).toContain("#1 get_app_state: output omitted (response size limit)");
    expect(out).toContain(`#2 get_app_state\n${text}`);
  });

  it.each([
    ["click", { element_index: "1", instructions: true }, "click does not accept instructions."],
    ["get_app_state", { find: "x", instructions: true }, "Pass find or instructions, not both."],
    ["get_app_state", { find: "x", instructions: false }, "Pass find or instructions, not both."],
    ["get_app_state", { instructions: "yes" }, "instructions must be a boolean."],
  ])("rejects %s %o before dispatch", async (method, extra, message) => {
    const { executePipeline } = await import("../src/desktop/pipeline.js");
    expect(await executePipeline(method, { app: "Test", ...extra }, ctx())).toEqual({ content: [{ type: "text", text: message }], isError: true });
    expect(brokerDispatch).not.toHaveBeenCalled();
  });
});
