// click action.

import type { CDPClient } from "../cdp/types.js";
import { resolveElement, releaseObject } from "./element-resolve.js";

export async function clickAction(
  cdp: CDPClient,
  sessionId: string,
  elementRefs: Map<number, number>,
  args: Record<string, unknown>
): Promise<string> {
  const id = args.id as number | undefined;
  const selector = args.selector as string | undefined;
  const x = args.x as number | undefined;
  const y = args.y as number | undefined;

  if (id != null) {
    return clickById(cdp, sessionId, elementRefs, id);
  }
  if (selector != null) {
    return clickBySelector(cdp, sessionId, selector);
  }
  if (x != null && y != null) {
    return clickByCoordinates(cdp, sessionId, x, y);
  }
  throw new Error("click requires id, selector, or x+y coordinates.");
}

async function dispatchClick(cdp: CDPClient, sessionId: string, cx: number, cy: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 }, sessionId);
  await new Promise((r) => setTimeout(r, 50));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 }, sessionId);
}

async function clickById(
  cdp: CDPClient, sessionId: string,
  elementRefs: Map<number, number>, id: number
): Promise<string> {
  const { objectId } = await resolveElement(cdp, sessionId, elementRefs, id);
  try {
    // Scroll into view.
    await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}',
      returnByValue: true,
    }, sessionId);
    await new Promise((r) => setTimeout(r, 50));

    // Get center and visibility check.
    const checkResult = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const rect = this.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { error: "Element has zero size" };
        const style = getComputedStyle(this);
        if (style.display === "none") return { error: "Element is display:none" };
        if (style.visibility === "hidden" || style.visibility === "collapse") return { error: "Element is hidden" };
        if (style.pointerEvents === "none") return { error: "Element has pointer-events:none" };
        if (parseFloat(style.opacity) === 0) return { error: "Element has zero opacity" };
        if (this.closest("[inert]")) return { error: "Element is inside [inert]" };
        if (this.disabled || this.getAttribute("aria-disabled") === "true") return { error: "Element is disabled" };
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== this && !this.contains(hit)) {
          return { error: "Element center is covered by " + (hit.tagName || "another element") };
        }
        return { cx, cy };
      }`,
      returnByValue: true,
    }, sessionId);

    const check = (checkResult.result as any)?.value;
    if (check?.error) throw new Error(check.error);

    await dispatchClick(cdp, sessionId, check.cx, check.cy);
    return `Clicked element ${id}`;
  } finally {
    await releaseObject(cdp, sessionId, objectId);
  }
}

async function clickBySelector(cdp: CDPClient, sessionId: string, selector: string): Promise<string> {
  const evalResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      if (els.length === 0) return { error: "Element not found" };
      if (els.length > 1) return { error: "Selector matched " + els.length + " elements" };
      const el = els[0];
      el.scrollIntoView({block:"center",inline:"center"});
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { error: "Element has zero size" };
      const style = getComputedStyle(el);
      if (style.display === "none") return { error: "Element is display:none" };
      if (style.visibility === "hidden" || style.visibility === "collapse") return { error: "Element is hidden" };
      if (style.pointerEvents === "none") return { error: "Element has pointer-events:none" };
      if (parseFloat(style.opacity) === 0) return { error: "Element has zero opacity" };
      if (el.closest("[inert]")) return { error: "Element is inside [inert]" };
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return { error: "Element is disabled" };
      const cx = rect.left + rect.width/2;
      const cy = rect.top + rect.height/2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit)) {
        return { error: "Element center is covered by " + (hit.tagName || "another element") };
      }
      return { cx, cy, tag: el.tagName, text: (el.textContent||"").slice(0,50) };
    })()`,
    returnByValue: true,
  }, sessionId);

  const val = (evalResult.result as any)?.value;
  if (val?.error) throw new Error(val.error);

  await new Promise((r) => setTimeout(r, 50));
  await dispatchClick(cdp, sessionId, val.cx, val.cy);
  return `Clicked ${val.tag} "${val.text}"`;
}

async function clickByCoordinates(cdp: CDPClient, sessionId: string, x: number, y: number): Promise<string> {
  await dispatchClick(cdp, sessionId, x, y);
  return `Clicked at CSS (${x}, ${y})`;
}
