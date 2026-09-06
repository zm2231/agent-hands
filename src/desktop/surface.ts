// Desktop Control surface: 10 verb-per-tool MCP tools for macOS native app control.

import type { SurfaceDescriptor, ToolDefinition, ToolResult, CallContext, SurfaceStatus } from "../kernel/types.js";
import { verifyBrokerComponents } from "./broker/verify.js";
import { executePipeline } from "./pipeline.js";
import { DESKTOP_TOOLS } from "./tools.js";

export function createDesktopSurface(): SurfaceDescriptor {
  return {
    name: "desktop",
    tools: DESKTOP_TOOLS,

    async isAvailable(): Promise<boolean> {
      try {
        await verifyBrokerComponents();
        return true;
      } catch {
        return false;
      }
    },

    async handle(
      toolName: string,
      args: Record<string, unknown>,
      ctx: CallContext
    ): Promise<ToolResult> {
      return executePipeline(toolName, args, ctx);
    },

    async status(): Promise<SurfaceStatus> {
      let brokerVerified = false;
      let brokerError: string | undefined;
      try {
        await verifyBrokerComponents();
        brokerVerified = true;
      } catch (e: unknown) {
        brokerError = e instanceof Error ? e.message : String(e);
      }
      return {
        brokerVerified,
        brokerError,
        permissionMode: "no-permissions",
        architecture: "official-codex-app-server-direct-mcp-tool-call",
        nestedModel: false,
        modelUsage: false,
        ephemeralZeroTurnRuntimeContextRequired: true,
      };
    },
  };
}
