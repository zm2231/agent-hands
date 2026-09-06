// navigate action.

import type { CDPClient } from "../cdp/types.js";

const NAVIGATION_TIMEOUT_MS = 30_000;

export async function navigateAction(
  cdp: CDPClient,
  sessionId: string,
  args: Record<string, unknown>
): Promise<string> {
  const url = args.url as string;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("navigate requires an http or https URL.");
  }

  await cdp.send("Page.enable", {}, sessionId);

  // Arm load event.
  const loadPromise = new Promise<void>((resolve) => {
    const handler = () => {
      cdp.off("Page.loadEventFired", handler);
      resolve();
    };
    cdp.on("Page.loadEventFired", handler);
    setTimeout(() => {
      cdp.off("Page.loadEventFired", handler);
      resolve();
    }, NAVIGATION_TIMEOUT_MS);
  });

  const result = await cdp.send("Page.navigate", { url }, sessionId);
  if ((result as any).errorText) {
    throw new Error((result as any).errorText);
  }

  if ((result as any).loaderId) {
    await loadPromise;
  }

  // Poll readyState.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    }, sessionId);
    if ((r.result as any)?.value === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return `Navigated to ${url}`;
}
