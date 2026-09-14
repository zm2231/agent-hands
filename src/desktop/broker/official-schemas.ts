export const EXPECTED_OFFICIAL_INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  list_apps: { type: "object", properties: {}, additionalProperties: false },
  get_app_state: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" } }, required: ["app"], additionalProperties: false },
  click: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, click_count: { description: "Number of clicks. Defaults to 1", type: "integer" }, element_index: { description: "Element index to click", type: "string" }, mouse_button: { description: "Mouse button to click. Defaults to left.", enum: ["left", "right", "middle"], type: "string" }, x: { description: "X coordinate in screenshot pixel coordinates", type: "number" }, y: { description: "Y coordinate in screenshot pixel coordinates", type: "number" } }, required: ["app"], additionalProperties: false },
  perform_secondary_action: { type: "object", properties: { action: { description: "Secondary accessibility action name", type: "string" }, app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, element_index: { description: "Element identifier", type: "string" } }, required: ["app", "element_index", "action"], additionalProperties: false },
  set_value: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, element_index: { description: "Element identifier", type: "string" }, value: { description: "Value to assign", type: "string" } }, required: ["app", "element_index", "value"], additionalProperties: false },
  select_text: { type: "object", properties: { app: { description: "App name or bundle identifier", type: "string" }, element_index: { description: "Text element identifier", type: "string" }, prefix: { description: "Optional text immediately before the target, used to disambiguate repeated matches", type: "string" }, selection: { description: "Whether to select the text or place the cursor before or after it. Defaults to text.", enum: ["text", "cursor_before", "cursor_after"], type: "string" }, suffix: { description: "Optional text immediately after the target, used to disambiguate repeated matches", type: "string" }, text: { description: "Target text as shown in the accessibility tree", type: "string" } }, required: ["app", "element_index", "text"], additionalProperties: false },
  scroll: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, direction: { description: "Scroll direction: up, down, left, or right", type: "string" }, element_index: { description: "Element identifier", type: "string" }, pages: { description: "Number of pages to scroll. Fractional values are supported. Defaults to 1", type: "number" } }, required: ["app", "element_index", "direction"], additionalProperties: false },
  drag: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, from_x: { description: "Start X coordinate", type: "number" }, from_y: { description: "Start Y coordinate", type: "number" }, to_x: { description: "End X coordinate", type: "number" }, to_y: { description: "End Y coordinate", type: "number" } }, required: ["app", "from_x", "from_y", "to_x", "to_y"], additionalProperties: false },
  press_key: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, key: { description: "Key or key combination to press", type: "string" } }, required: ["app", "key"], additionalProperties: false },
  type_text: { type: "object", properties: { app: { description: "App name, full app path, or unambiguous bundle identifier", type: "string" }, text: { description: "Literal text to type", type: "string" } }, required: ["app", "text"], additionalProperties: false },
};

export function schemasEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeSchema(left)) === JSON.stringify(normalizeSchema(right));
}

export function validateOfficialToolInventory(tools: unknown): void {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new Error("Inventory computer-use server exposed no tool table.");
  }
  const expectedMethods = Object.keys(EXPECTED_OFFICIAL_INPUT_SCHEMAS).sort();
  const toolTable = tools as Record<string, unknown>;
  const toolNames = Object.keys(toolTable).sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedMethods)) {
    throw new Error(`Inventory tool mismatch. Expected: ${expectedMethods.join(",")}; got: ${toolNames.join(",")}`);
  }
  for (const method of expectedMethods) {
    const upstream = toolTable[method] as Record<string, unknown> | undefined;
    const schema = upstream?.inputSchema ?? upstream?.input_schema;
    if (!schemasEqual(schema, EXPECTED_OFFICIAL_INPUT_SCHEMAS[method])) {
      throw new Error(`Inventory schema mismatch for ${method}.`);
    }
  }
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalizeSchema(child)]));
  }
  return value;
}
