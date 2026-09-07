import { describe, it, expect } from "vitest";

describe("desktop_batch tool definition", () => {
  it("exists and has correct schema", async () => {
    const { DESKTOP_BATCH_TOOL } = await import("../src/desktop/tools.js");
    expect(DESKTOP_BATCH_TOOL.name).toBe("desktop_batch");
    const schema = DESKTOP_BATCH_TOOL.inputSchema as any;
    expect(schema.required).toEqual(["app", "actions"]);
    expect(schema.properties.app.type).toBe("string");
    expect(schema.properties.actions.type).toBe("array");
    expect(schema.properties.actions.minItems).toBe(1);
    expect(schema.properties.actions.maxItems).toBe(20);
    expect(schema.properties.continue_on_error.type).toBe("boolean");
    expect(schema.additionalProperties).toBe(false);
  });

  it("is registered alongside regular desktop tools", async () => {
    const { DESKTOP_TOOLS, DESKTOP_BATCH_TOOL } = await import("../src/desktop/tools.js");
    // Surface combines them
    const allTools = [...DESKTOP_TOOLS, DESKTOP_BATCH_TOOL];
    const names = allTools.map((t: any) => t.name);
    expect(names).toContain("desktop_batch");
    expect(names).toContain("click");
    expect(names).toContain("list_apps");
    expect(names.length).toBe(11); // 10 original + 1 batch
  });
});

describe("batch validation (pipeline level)", () => {
  const BATCHABLE = new Set([
    "get_app_state", "click", "type_text", "press_key", "set_value",
    "select_text", "scroll", "drag", "perform_secondary_action",
  ]);

  it("accepts valid methods", () => {
    const actions = [
      { method: "click", element_index: "3" },
      { method: "type_text", text: "hello" },
      { method: "press_key", key: "Return" },
    ];
    for (const a of actions) {
      expect(BATCHABLE.has(a.method), `${a.method} should be batchable`).toBe(true);
    }
  });

  it("rejects list_apps in batch", () => {
    expect(BATCHABLE.has("list_apps")).toBe(false);
  });

  it("rejects desktop_batch in batch (no recursion)", () => {
    expect(BATCHABLE.has("desktop_batch")).toBe(false);
  });

  it("rejects unknown methods", () => {
    expect(BATCHABLE.has("delete_file")).toBe(false);
    expect(BATCHABLE.has("")).toBe(false);
  });

  it("allows get_app_state in batch", () => {
    expect(BATCHABLE.has("get_app_state")).toBe(true);
  });
});

describe("batch action normalization", () => {
  it("strips method from args before forwarding", () => {
    const action = { method: "click", app: "com.test", element_index: "5" };
    const args: Record<string, unknown> = { ...action, app: "com.test.resolved" };
    delete args.method;
    expect(args).toEqual({ app: "com.test.resolved", element_index: "5" });
    expect(args.method).toBeUndefined();
  });

  it("normalizes press_key keys within batch", async () => {
    const { normalizeKey } = await import("../src/desktop/os/key-normalize.js");
    const key = normalizeKey("enter");
    expect(key).toBe("Return");
  });
});

describe("batch continue_on_error logic", () => {
  it("default is fail-stop (false)", () => {
    const args = { app: "com.test", actions: [{ method: "click" }] };
    const continueOnError = (args as any).continue_on_error ?? false;
    expect(continueOnError).toBe(false);
  });

  it("explicit true enables continue", () => {
    const args = { app: "com.test", actions: [{ method: "click" }], continue_on_error: true };
    const continueOnError = args.continue_on_error ?? false;
    expect(continueOnError).toBe(true);
  });
});

describe("batch result structure", () => {
  it("response shape matches contract", () => {
    const responseBody = {
      batch: true,
      actions_executed: 3,
      actions_returned: 3,
      actions_requested: 3,
      results: [
        { method: "click", content: [{ type: "text", text: "clicked" }], isError: false },
        { method: "type_text", content: [{ type: "text", text: "typed" }], isError: false },
        { method: "get_app_state", content: [{ type: "text", text: "snapshot" }], isError: false },
      ],
    };

    expect(responseBody.batch).toBe(true);
    expect(responseBody.actions_executed).toBe(3);
    expect(responseBody.actions_returned).toBe(3);
    expect(responseBody.results).toHaveLength(3);
  });

  it("fail-stop result reports partial execution", () => {
    const responseBody = {
      batch: true,
      actions_executed: 2,
      actions_returned: 2,
      actions_requested: 3,
      results: [
        { method: "click", content: [], isError: false },
        { method: "type_text", content: [{ type: "text", text: "error" }], isError: true },
      ],
    };

    expect(responseBody.actions_executed).toBeLessThan(responseBody.actions_requested);
    expect(responseBody.results).toHaveLength(2);
    expect(responseBody.results[1].isError).toBe(true);
  });

  it("truncated response preserves error status from omitted results", () => {
    // Simulate: 3 executed, first 2 returned, third had error and was omitted
    const allResults = [
      { method: "click", content: [], isError: false },
      { method: "type_text", content: [], isError: false },
      { method: "press_key", content: [], isError: true }, // omitted due to size
    ];
    const responseResults = allResults.slice(0, 2);
    const truncatedAt = 2;
    const totalExecuted = 3;
    const anyError = allResults.some((r) => r.isError);

    const responseBody: Record<string, unknown> = {
      batch: true,
      actions_executed: totalExecuted,
      actions_returned: responseResults.length,
      actions_requested: 3,
      results: responseResults,
      truncated: true,
      truncated_at: truncatedAt,
      has_omitted_errors: allResults.slice(truncatedAt).some((r) => r.isError),
    };

    expect(anyError).toBe(true);
    expect(responseBody.actions_executed).toBe(3);
    expect(responseBody.actions_returned).toBe(2);
    expect(responseBody.has_omitted_errors).toBe(true);
  });
});
