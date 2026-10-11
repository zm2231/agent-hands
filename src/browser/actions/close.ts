import type { CDPClient } from "../cdp/types.js";

export async function closeTabAction(
  cdp: CDPClient,
  sessionId: string,
  isOpen: () => Promise<boolean>,
  timeoutMs = 3_000,
  pollMs = 100
): Promise<string> {
  await cdp.send("Page.close", {}, sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isOpen())) return "Tab closed.";
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Tab is still open; the page may be showing a leave-page prompt.");
}
