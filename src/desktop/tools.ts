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
      "Get the accessibility tree and screenshot of an app. This must be called once per assistant turn before interacting with the app.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", description: APP_DESC } },
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
        click_count: {
          type: "integer",
          description: "Number of clicks. Defaults to 1",
        },
        element_index: { type: "string", description: "Element index to click" },
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
        element_index: { type: "string", description: "Element index" },
        action: {
          type: "string",
          description: "Secondary accessibility action name",
        },
      },
      required: ["app", "element_index", "action"],
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
        element_index: { type: "string", description: "Element index" },
        value: { type: "string", description: "Value to set" },
      },
      required: ["app", "element_index", "value"],
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
        element_index: { type: "string", description: "Element index" },
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
      required: ["app", "element_index", "text"],
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
        element_index: { type: "string", description: "Element index" },
        direction: {
          type: "string",
          description: "Scroll direction: up, down, left, or right",
        },
        pages: {
          type: "number",
          description: "Number of pages to scroll (supports fractions). Defaults to 1.",
        },
      },
      required: ["app", "element_index", "direction"],
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
        text: { type: "string", description: "Text to type" },
      },
      required: ["app", "text"],
      additionalProperties: false,
    },
    annotations: ACTION_ANNOTATIONS,
  },
];

export const DESKTOP_METHOD_NAMES = DESKTOP_TOOLS.map((t) => t.name);
