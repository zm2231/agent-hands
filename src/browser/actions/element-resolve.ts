// Element resolution: id -> backendDOMNodeId -> live JS object.

import type { CDPClient } from "../cdp/types.js";

export async function resolveElement(
  cdp: CDPClient,
  sessionId: string,
  elementRefs: Map<number, number>,
  id: number
): Promise<{ objectId: string; backendNodeId: number }> {
  const backendNodeId = elementRefs.get(id);
  if (backendNodeId == null) {
    throw new Error(
      `Unknown element id ${id}; run open again and use a current element id.`
    );
  }

  const result = await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = (result.object as any)?.objectId;
  if (!objectId) {
    throw new Error("Element is no longer available; run open again.");
  }
  return { objectId, backendNodeId };
}

export async function releaseObject(
  cdp: CDPClient,
  sessionId: string,
  objectId: string
): Promise<void> {
  try {
    await cdp.send("Runtime.releaseObject", { objectId }, sessionId);
  } catch {
    // Best effort.
  }
}
