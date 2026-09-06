// raw action: escape hatch to any CDP method.

import type { CDPClient } from "../cdp/types.js";

export async function rawAction(
  cdp: CDPClient,
  sessionId: string,
  args: Record<string, unknown>
): Promise<string> {
  const method = args.method as string;
  if (!method) throw new Error("CDP method required.");
  const params = (args.params ?? {}) as Record<string, unknown>;

  const result = await cdp.send(method, params, sessionId);
  return JSON.stringify(result, null, 2);
}
