import { compactTree } from "./ax-tree.js";

const MAX_VALUE_CHARS = 200;
const SAVE_TO_TMP_THRESHOLD = 50_000;

export function trimAxTree(text: string): { text: string; trimmed: boolean; originalLength: number } {
  const originalLength = text.length;
  let trimmed = false;
  const marker = "Value: ";

  const parts: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const idx = text.indexOf(marker, pos);
    if (idx === -1) {
      parts.push(text.slice(pos));
      break;
    }

    parts.push(text.slice(pos, idx + marker.length));
    const valueStart = idx + marker.length;

    // Find end of this value: next \n\t followed by a digit (next element),
    // or next \n followed by tab+digit, or end of string.
    let valueEnd = text.length;
    let searchPos = valueStart;
    while (searchPos < text.length) {
      const nl = text.indexOf("\n", searchPos);
      if (nl === -1) { valueEnd = text.length; break; }
      // Check if next line starts a new element (tabs + digit)
      const afterNl = text.slice(nl + 1, nl + 20);
      if (/^\t*\d/.test(afterNl) || afterNl.startsWith("</")) {
        valueEnd = nl;
        break;
      }
      searchPos = nl + 1;
    }

    const value = text.slice(valueStart, valueEnd);
    if (value.length > MAX_VALUE_CHARS) {
      trimmed = true;
      parts.push(value.slice(0, MAX_VALUE_CHARS) + `... [${value.length} chars total]`);
    } else {
      parts.push(value);
    }
    pos = valueEnd;
  }

  return { text: parts.join(""), trimmed, originalLength };
}

export function presentTree(text: string, compact: boolean, tmpPath?: string): string {
  const trim = trimAxTree(text);
  const compacted = compact ? compactTree(trim.text) : null;
  if (!trim.trimmed && !compacted) return text;
  const body = compacted ? compacted.text : trim.text;
  const notes = [`AX tree trimmed: ${trim.originalLength} -> ${body.length} chars`];
  if (compacted) {
    notes.push(`${compacted.shown} of ${compacted.total} elements shown; "… N more" lines name hidden ones. Use find, target, or full: true to reach them`);
  }
  if (tmpPath) notes.push(`Full tree saved to ${tmpPath}`);
  return `[${notes.join(". ")}]\n${body}`;
}

export function trimContentBlocks(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
  tmpPath?: string,
  compact = false,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  return content.map((block) => {
    if (block.type !== "text" || !block.text) return block;
    const text = presentTree(block.text, compact, tmpPath);
    return text === block.text ? block : { ...block, text };
  });
}

export { SAVE_TO_TMP_THRESHOLD };
