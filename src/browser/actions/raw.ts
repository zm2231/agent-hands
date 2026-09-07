import type { CDPClient } from "../cdp/types.js";

const ALLOWED_DOMAINS = new Set([
  "DOM", "CSS", "DOMDebugger", "DOMSnapshot", "Overlay",
  "Page", "Runtime", "Network", "Emulation", "Input",
  "Performance", "Accessibility", "Animation",
]);

export async function rawAction(
  cdp: CDPClient,
  sessionId: string,
  args: Record<string, unknown>
): Promise<string> {
  const method = args.method as string;
  if (!method) throw new Error("CDP method required.");

  const domain = method.split(".")[0];
  if (!ALLOWED_DOMAINS.has(domain)) {
    throw new Error(
      `CDP domain "${domain}" is not allowed. ` +
      `Permitted: ${[...ALLOWED_DOMAINS].sort().join(", ")}.`
    );
  }

  const params = (args.params ?? {}) as Record<string, unknown>;
  const result = await cdp.send(method, params, sessionId);
  return JSON.stringify(result, null, 2);
}
