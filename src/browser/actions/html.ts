// html action.

import type { CDPClient } from "../cdp/types.js";
import { resolveElement, releaseObject } from "./element-resolve.js";

export async function htmlAction(
  cdp: CDPClient,
  sessionId: string,
  elementRefs: Map<number, number>,
  args: Record<string, unknown>
): Promise<string> {
  const id = args.id as number | undefined;
  const selector = args.selector as string | undefined;

  if (id != null) {
    const { objectId } = await resolveElement(cdp, sessionId, elementRefs, id);
    try {
      const r = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){return this.outerHTML}",
        returnByValue: true,
      }, sessionId);
      return (r.result as any)?.value ?? "";
    } finally {
      await releaseObject(cdp, sessionId, objectId);
    }
  }

  if (selector) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found: ${selector}");
        return el.outerHTML;
      })()`,
      returnByValue: true,
    }, sessionId);
    if ((r as any).exceptionDetails) {
      throw new Error((r as any).exceptionDetails.exception?.description ?? "Element not found");
    }
    return (r.result as any)?.value ?? "";
  }

  const r = await cdp.send("Runtime.evaluate", {
    expression: "document.documentElement.outerHTML",
    returnByValue: true,
  }, sessionId);
  return (r.result as any)?.value ?? "";
}
