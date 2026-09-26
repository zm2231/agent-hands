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
