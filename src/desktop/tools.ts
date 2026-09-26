// Desktop tool definitions: 10 verb tools with exact schemas.

import type { ToolDefinition, ToolAnnotations } from "../kernel/types.js";

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const ACTION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const APP_DESC = "App name, full app path, or unambiguous bundle identifier";
const SCREENSHOT_PROP = { type: "boolean", description: "Include a screenshot with the returned app state. Defaults to false." };
const TARGET_PROP = {
  type: "object",
  description:
    "Act on the element with this label instead of element_index. The server reads the app state itself, so no get_app_state call is needed first. " +
    "Nothing happens if no element or several elements match; the response lists candidates.",
  properties: {
    role: { type: "string", description: "Role as shown before the name in the accessibility tree, e.g. button, toggle button, row. Needed to match by name when the role is app-defined or not in English." },
    name: { type: "string", description: "Element name, description, value, or ID." },
    match: { type: "string", enum: ["exact", "contains"], description: "Defaults to exact." },
  },
  required: ["name"],
  additionalProperties: false,
};

export const DESKTOP_TOOLS: ToolDefinition[] = [
  {
    name: "list_apps",
    description: "List running macOS applications.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ANNOTATIONS,
  },
  {
    name: "get_app_state",
    description:
      "Get the accessibility tree of an app, plus a screenshot when requested. Large trees come back compact, with hidden elements named " +
      "in \"… N more\" lines; use find to return only matching elements, or full for everything. Not needed before actions that use target.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        find: { type: "string", description: "Return only elements whose name, description, value, ID, or help text contains this text, each with its parent path." },
        full: { type: "boolean", description: "Return every element instead of the compact view. Long values are still shortened." },
        instructions: { type: "boolean", description: "Include the app's usage instructions even if they were shown in the last 10 minutes." },
      },
      required: ["app"],
      additionalProperties: false,
    },
    annotations: READ_ANNOTATIONS,
  },
  {
    name: "click",
    description: "Click on an element or coordinate in an app.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        click_count: {
          type: "integer",
          description: "Number of clicks. Defaults to 1",
        },
        element_index: { type: "string", description: "Element index to click" },
        target: TARGET_PROP,
        mouse_button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button to click. Defaults to left.",
        },
        x: { type: "number", description: "Screenshot pixel X coordinate" },
        y: { type: "number", description: "Screenshot pixel Y coordinate" },
      },
      required: ["app"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "perform_secondary_action",
    description: "Perform a secondary accessibility action on an element.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        element_index: { type: "string", description: "Element index" },
        target: TARGET_PROP,
        action: {
          type: "string",
          description: "Secondary accessibility action name",
        },
      },
      required: ["app", "action"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "set_value",
    description: "Set the value of an accessibility element.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        element_index: { type: "string", description: "Element index" },
        target: TARGET_PROP,
        value: { type: "string", description: "Value to set" },
      },
      required: ["app", "value"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "select_text",
    description: "Select text in an app element.",
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "App name or bundle identifier",
        },
        screenshot: SCREENSHOT_PROP,
        element_index: { type: "string", description: "Element index" },
        target: TARGET_PROP,
        text: {
          type: "string",
          description: "Target text as shown in the accessibility tree",
        },
        prefix: { type: "string", description: "Text before the target (disambiguates)" },
        selection: {
          type: "string",
          enum: ["text", "cursor_before", "cursor_after"],
          description: "Selection mode. Defaults to text.",
        },
        suffix: { type: "string", description: "Text after the target (disambiguates)" },
      },
      required: ["app", "text"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "scroll",
    description: "Scroll within an app element.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        element_index: { type: "string", description: "Element index" },
        target: TARGET_PROP,
        direction: {
          type: "string",
          description: "Scroll direction: up, down, left, or right",
        },
        pages: {
          type: "number",
          description: "Number of pages to scroll (supports fractions). Defaults to 1.",
        },
      },
      required: ["app", "direction"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "drag",
    description: "Drag from one point to another in an app.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        from_x: { type: "number", description: "Start X" },
        from_y: { type: "number", description: "Start Y" },
        to_x: { type: "number", description: "End X" },
        to_y: { type: "number", description: "End Y" },
      },
      required: ["app", "from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "press_key",
    description: "Press a key or key combination in an app.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        key: { type: "string", description: "Key in xdotool syntax (e.g. \"a\", \"Return\", \"super+c\")" },
      },
      required: ["app", "key"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
  {
    name: "type_text",
    description: "Type text into an app.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: APP_DESC },
        screenshot: SCREENSHOT_PROP,
        text: { type: "string", description: "Text to type" },
      },
      required: ["app", "text"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
];

// Batch tool: run multiple same-app actions in one broker session.
export const DESKTOP_BATCH_TOOL: ToolDefinition = {
  name: "desktop_batch",
  description:
    "Run multiple desktop actions on the same app in a single call. " +
    "All actions execute sequentially in one broker session (one process spawn). " +
    "Stops on first error by default; set continue_on_error to keep going.",
  inputSchema: {
    type: "object",
    properties: {
      app: { type: "string", description: APP_DESC },
      actions: {
        type: "array",
        description:
          "Array of actions to execute. Each object must have a 'method' field " +
          "(one of the desktop tool names except list_apps and desktop_batch) " +
          "and the parameters for that method. Mutations report ok or an error; " +
          "use get_app_state (optionally with screenshot: true) to return state.",
        items: {
          type: "object",
          properties: {
            method: { type: "string" },
          },
          required: ["method"],
        },
        minItems: 1,
        maxItems: 20,
      },
      continue_on_error: {
        type: "boolean",
        description:
          "When true, continue executing remaining actions after an error. " +
          "Default: false (fail-stop).",
      },
    },
    required: ["app", "actions"],
    additionalProperties: false,
  },
  annotations: ACTION_ANNOTATIONS,
};

export const DESKTOP_METHOD_NAMES = DESKTOP_TOOLS.map((t) => t.name);
