// evaluate action.

import type { CDPClient } from "../cdp/types.js";

export async function evaluateAction(
  cdp: CDPClient,
  sessionId: string,
  args: Record<string, unknown>
): Promise<string> {
  const expression = args.expression as string;
  if (expression.length > 1_000_000) throw new Error("Expression exceeds 1 MB limit.");

  await cdp.send("Runtime.enable", {}, sessionId);

  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);

  if ((result as any).exceptionDetails) {
    const exc = (result as any).exceptionDetails;
    throw new Error(exc.exception?.description ?? exc.text ?? "Evaluation error");
  }

  const value = (result.result as any)?.value;
  if (value != null && typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value ?? "");
}
