const BLOCK_RE = /<app_specific_instructions>\n[\s\S]*?\n<\/app_specific_instructions>\n?/;
export const INSTRUCTIONS_REPEAT_MS = 10 * 60_000;

const shown = new Map<string, { block: string; at: number }>();

export interface PresentedInstructions {
  text: string;
  markShown: () => void;
}

export function presentInstructions(text: string, app: string, force: boolean, now = Date.now()): PresentedInstructions {
  const match = BLOCK_RE.exec(text);
  const last = shown.get(app);
  const showing = (block: string, out: string) => ({ text: out, markShown: () => { shown.set(app, { block, at: now }); } });
  const unchanged = { text, markShown: () => {} };
  if (!match) {
    if (!force || !last) return unchanged;
    const at = text.indexOf("<app_state>");
    return showing(last.block, at === -1 ? last.block + text : text.slice(0, at) + last.block + text.slice(at));
  }
  const block = match[0];
  if (force || !last || last.block !== block || now - last.at >= INSTRUCTIONS_REPEAT_MS) return showing(block, text);
  const minutes = Math.floor((now - last.at) / 60_000);
  const when = minutes < 1 ? "under a minute ago" : `${minutes} min ago`;
  const title = /^## (.+)$/m.exec(block)?.[1] ?? "App instructions";
  const pointer = `[${title}: app instructions shown ${when}; pass instructions: true to include them again]\n`;
  return { text: text.slice(0, match.index) + pointer + text.slice(match.index + block.length), markShown: () => {} };
}
