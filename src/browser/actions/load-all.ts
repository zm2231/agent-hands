// load_all action: click a "load more" button until it disappears.

import type { CDPClient } from "../cdp/types.js";

const DEADLINE_MS = 5 * 60 * 1000; // 5 minutes

export async function loadAllAction(
  cdp: CDPClient,
  sessionId: string,
  args: Record<string, unknown>
): Promise<string> {
  const selector = args.selector as string;
  const rawInterval = args.interval_ms as number | undefined;
  const intervalMs = rawInterval != null
    ? Math.max(0, Math.min(60_000, Math.floor(rawInterval)))
    : 1500;
  const deadline = Date.now() + DEADLINE_MS;
  let clicks = 0;

  while (Date.now() < deadline) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({block:"center"});
        el.click();
        return true;
      })()`,
      returnByValue: true,
    }, sessionId);

    if ((r.result as any)?.value == null) {
      return `Clicked ${clicks} times. Stopped: element disappeared.`;
    }
    clicks++;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return `Clicked ${clicks} times. Stopped: 5-minute deadline reached.`;
}
