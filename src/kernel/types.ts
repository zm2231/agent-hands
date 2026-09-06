// Kernel types for agent-hands MCP server.

export interface ContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  [key: string]: unknown;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export interface ElicitationRequest {
  [key: string]: unknown;
}

export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
}

export interface AuditRecord {
  timestamp: string;
  runId: string;
  method: string;
  [key: string]: unknown;
}

export interface CallContext {
  signal: AbortSignal;
  elicit(request: ElicitationRequest): Promise<ElicitationResponse>;
  audit(record: AuditRecord): Promise<void>;
}

export interface SurfaceStatus {
  [key: string]: unknown;
}

export interface SurfaceDescriptor {
  /** Name of this surface for routing and status. */
  name: string;
  /** Tools this surface contributes to list-tools. */
  tools: ToolDefinition[];
  /** Return false to withhold every tool in this surface. */
  isAvailable(): Promise<boolean> | boolean;
  /** Execute one already-name-matched, schema-valid call. */
  handle(toolName: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult>;
  /** Surface-specific status fields. */
  status?(): Promise<SurfaceStatus> | SurfaceStatus;
}
