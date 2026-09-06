// type action.

import type { CDPClient } from "../cdp/types.js";
import { resolveElement, releaseObject } from "./element-resolve.js";

export async function typeAction(
  cdp: CDPClient,
  sessionId: string,
  elementRefs: Map<number, number>,
  args: Record<string, unknown>
): Promise<string> {
  const text = args.text as string;
  const id = args.id as number | undefined;

  if (id != null) {
    return typeById(cdp, sessionId, elementRefs, id, text);
  }
  return typeAtFocus(cdp, sessionId, text);
}

async function typeById(
  cdp: CDPClient, sessionId: string,
  elementRefs: Map<number, number>, id: number, text: string
): Promise<string> {
  const { objectId } = await resolveElement(cdp, sessionId, elementRefs, id);
  try {
    // Scroll into view.
    await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}',
      returnByValue: true,
    }, sessionId);

    // Verify editable, focus, type.
    const checkResult = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const tag = this.tagName;
        const type = (this.type || "").toLowerCase();
        const editableInputs = ["text","search","email","url","tel","password","number",""];
        const isInput = tag === "INPUT" && editableInputs.includes(type);
        const isTextarea = tag === "TEXTAREA";
        const isCE = this.isContentEditable;
        if (!isInput && !isTextarea && !isCE) return { error: "Element is not editable" };
        if (this.disabled) return { error: "Element is disabled" };
        if (this.readOnly) return { error: "Element is readonly" };
        this.focus({preventScroll:true});
        if (document.activeElement !== this) return { error: "Could not focus element" };
        return { tag, before: this.value ?? this.textContent ?? "" };
      }`,
      returnByValue: true,
    }, sessionId);

    const check = (checkResult.result as any)?.value;
    if (check?.error) throw new Error(check.error);

    await cdp.send("Input.insertText", { text }, sessionId);

    return `Typed ${text.length} characters into referenced ${check.tag}`;
  } finally {
    await releaseObject(cdp, sessionId, objectId);
  }
}

async function typeAtFocus(cdp: CDPClient, sessionId: string, text: string): Promise<string> {
  const checkResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { error: "No element is focused" };
      const tag = el.tagName;
      const type = (el.type || "").toLowerCase();
      const editableInputs = ["text","search","email","url","tel","password","number",""];
      const isInput = tag === "INPUT" && editableInputs.includes(type);
      const isTextarea = tag === "TEXTAREA";
      const isCE = el.isContentEditable;
      if (!isInput && !isTextarea && !isCE) return { error: "Focused element is not editable" };
      if (el.disabled) return { error: "Focused element is disabled" };
      return { tag };
    })()`,
    returnByValue: true,
  }, sessionId);

  const check = (checkResult.result as any)?.value;
  if (check?.error) throw new Error(check.error);

  await cdp.send("Input.insertText", { text }, sessionId);

  return `Typed ${text.length} characters into focused ${check.tag}`;
}
