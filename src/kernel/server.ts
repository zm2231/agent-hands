// Kernel: MCP server with surface registration, routing, validation, and sanitizing.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  SurfaceDescriptor,
  ToolResult,
  CallContext,
} from "./types.js";
import { sanitizeError } from "./sanitize.js";
import { buildStatus } from "./status.js";
import { validateArgs } from "./validate.js";
import { auditAppend } from "./audit.js";

const VERSION = "0.1.0";

export function createServer(surfaces: SurfaceDescriptor[]): {
  run(): Promise<void>;
  status(): Promise<Record<string, unknown>>;
} {
  const server = new Server(
    { name: "agent-hands", version: VERSION },
    { capabilities: { logging: {}, tools: {} } }
  );

  // Build a stable tool-name -> surface registry at construction time.
  // This ensures call-tool works even if list-tools was never called.
  const toolOwner = new Map<string, SurfaceDescriptor>();
  const toolSchemas = new Map<string, Record<string, unknown>>();
  for (const surface of surfaces) {
    for (const tool of surface.tools) {
      toolOwner.set(tool.name, surface);
      toolSchemas.set(tool.name, tool.inputSchema);
    }
  }

  // list-tools: evaluate availability per call (components can be installed at runtime).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<Record<string, unknown>> = [];

    // Status tool (always present).
    tools.push({
      name: "status",
      description: "Return the agent-hands server status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });

    for (const surface of surfaces) {
      let available: boolean;
      try {
        available = await Promise.resolve(surface.isAvailable());
      } catch {
        available = false;
      }
      if (!available) continue;

      for (const tool of surface.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
    }

    return { tools };
  });

  // call-tool: route to the owning surface, re-checking availability.
  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    const { name, arguments: rawArgs } = request.params;

    // Status tool.
    if (name === "status") {
      const s = await buildStatus(surfaces, VERSION);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }],
        structuredContent: s,
        isError: false,
      };
    }

    const surface = toolOwner.get(name);
    if (!surface) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Re-check availability at call time.
    let available: boolean;
    try {
      available = await Promise.resolve(surface.isAvailable());
    } catch {
      available = false;
    }
    if (!available) {
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is not currently available (surface prerequisites not met).` }],
        isError: true,
      };
    }

    const schema = toolSchemas.get(name);
    if (schema) {
      const err = validateArgs(rawArgs ?? {}, schema);
      if (err) {
        return {
          content: [{ type: "text" as const, text: err }],
          isError: true,
        };
      }
    }

    const ctx: CallContext = {
      signal: AbortSignal.timeout(120_000),
      elicit: async () => ({ action: "cancel" as const }),
      audit: async (record) => {
        await auditAppend(record);
      },
    };

    try {
      const result = await surface.handle(name, (rawArgs ?? {}) as Record<string, unknown>, ctx);
      // Sanitize all text blocks in error results from surfaces.
      if (result.isError && result.content) {
        for (const block of result.content) {
          if (block.type === "text" && block.text) {
            block.text = sanitizeError(block.text);
          }
        }
      }
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: sanitizeError(msg) }],
        isError: true,
      };
    }
  });

  return {
    async run() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async status() {
      return buildStatus(surfaces, VERSION);
    },
  };
}
