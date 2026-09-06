// network action.

import type { CDPClient } from "../cdp/types.js";

export async function networkAction(
  cdp: CDPClient,
  sessionId: string
): Promise<string> {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(performance.getEntriesByType("resource").map(e=>({name:e.name.slice(0,120),type:e.initiatorType,duration:Math.round(e.duration),size:e.transferSize})))`,
    returnByValue: true,
  }, sessionId);

  const entries = JSON.parse((r.result as any)?.value ?? "[]");
  const lines = entries.map((e: any) =>
    `${String(e.duration).padStart(6)}ms  ${String(e.size).padStart(8)}B  ${e.type.padEnd(10)}  ${e.name}`
  );
  return lines.join("\n");
}
