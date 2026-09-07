const MAX_VALUE_CHARS = 200;
const SAVE_TO_TMP_THRESHOLD = 50_000;

export function trimAxTree(text: string): { text: string; trimmed: boolean; originalLength: number } {
  const originalLength = text.length;
  let trimmed = false;
  const marker = "Value: ";

  let result = "";
  let pos = 0;

  while (pos < text.length) {
    const idx = text.indexOf(marker, pos);
    if (idx === -1) {
      result += text.slice(pos);
      break;
    }

    result += text.slice(pos, idx + marker.length);
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
      result += value.slice(0, MAX_VALUE_CHARS) + `... [${value.length} chars total]`;
    } else {
      result += value;
    }
    pos = valueEnd;
  }

  return { text: result, trimmed, originalLength };
}

export function trimContentBlocks(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
  tmpPath?: string,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  return content.map((block) => {
    if (block.type !== "text" || !block.text) return block;

    const { text, trimmed, originalLength } = trimAxTree(block.text);
    if (!trimmed) return block;

    const header = tmpPath
      ? `[AX tree trimmed: ${originalLength} -> ${text.length} chars. Full tree saved to ${tmpPath}]\n`
      : `[AX tree trimmed: ${originalLength} -> ${text.length} chars]\n`;

    return { ...block, text: header + text };
  });
}

export { SAVE_TO_TMP_THRESHOLD };
