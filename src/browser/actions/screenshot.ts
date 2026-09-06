// screenshot action.

import type { CDPClient } from "../cdp/types.js";
import { resolveElement, releaseObject } from "./element-resolve.js";
import { saveScreenshot } from "../artifacts.js";

export async function screenshotAction(
  cdp: CDPClient,
  sessionId: string,
  elementRefs: Map<number, number>,
  refId: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = args.id as number | undefined;
  const selector = args.selector as string | undefined;

  // Get device pixel ratio.
  let dpr = 1;
  try {
    const r = await cdp.send("Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    }, sessionId);
    dpr = (r.result as any)?.value ?? 1;
  } catch { /* default */ }

  let clip: Record<string, number> | undefined;

  if (selector) {
    const evalResult = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({block:"center",inline:"center"});
        const r = el.getBoundingClientRect();
        return { x: Math.max(0,r.x-10), y: Math.max(0,r.y-10),
          width: Math.min(r.width+20, window.innerWidth), height: Math.min(r.height+20, window.innerHeight) };
      })()`,
      returnByValue: true,
    }, sessionId);
    clip = (evalResult.result as any)?.value ?? undefined;
    if (!clip) throw new Error(`Element not found: ${selector}`);
  } else if (id != null) {
    const { objectId } = await resolveElement(cdp, sessionId, elementRefs, id);
    try {
      await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}',
        returnByValue: true,
      }, sessionId);

      const boxResult = await cdp.send("DOM.getBoxModel", {
        objectId,
      }, sessionId);
      const model = boxResult.model as any;
      if (model?.border) {
        const border = model.border as number[];
        const xs = [border[0], border[2], border[4], border[6]];
        const ys = [border[1], border[3], border[5], border[7]];
        const minX = Math.max(0, Math.min(...xs) - 10);
        const minY = Math.max(0, Math.min(...ys) - 10);
        const maxX = Math.max(...xs) + 10;
        const maxY = Math.max(...ys) + 10;

        // Clamp to layout viewport.
        const layoutResult = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
        const vp = (layoutResult.layoutViewport ?? layoutResult.cssLayoutViewport) as any;
        const vpW = vp?.clientWidth ?? 1920;
        const vpH = vp?.clientHeight ?? 1080;

        clip = {
          x: minX, y: minY,
          width: Math.min(maxX - minX, vpW),
          height: Math.min(maxY - minY, vpH),
          scale: 1,
        };
      }
    } finally {
      await releaseObject(cdp, sessionId, objectId);
    }
  }

  const captureParams: Record<string, unknown> = {
    format: "png",
    captureBeyondViewport: false,
  };
  if (clip) captureParams.clip = clip;

  const result = await cdp.send("Page.captureScreenshot", captureParams, sessionId);
  const data = result.data as string;
  const buffer = Buffer.from(data, "base64");
  const filepath = await saveScreenshot(buffer, refId, id);

  return {
    ref_id: refId,
    ...(id != null ? { id } : {}),
    ...(selector ? { selector } : {}),
    file: filepath,
    dpr,
    coordinates: "CSS pixels; screenshot pixels / DPR",
  };
}
