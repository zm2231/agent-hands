const MAX_ELEMENT_TEXT_CHARS = 200;
const SAVE_TO_TMP_THRESHOLD = 50_000;
const VALUE_PATTERN = /^(\s*Value:\s*)(.+)$/gm;
const QUOTED_LABEL_PATTERN = /^(\s*\[\d+\]\s+\w+\s+")(.{201,})(".*)/gm;

export function trimAxTree(text: string): { text: string; trimmed: boolean; originalLength: number } {
  const originalLength = text.length;
  let trimmed = false;

  let result = text.replace(VALUE_PATTERN, (_match, prefix: string, value: string) => {
    if (value.length <= MAX_ELEMENT_TEXT_CHARS) return _match;
    trimmed = true;
    const preview = value.slice(0, MAX_ELEMENT_TEXT_CHARS);
    return `${prefix}${preview}... [${value.length} chars total]`;
  });

  result = result.replace(QUOTED_LABEL_PATTERN, (_match, prefix: string, label: string, suffix: string) => {
    if (label.length <= MAX_ELEMENT_TEXT_CHARS) return _match;
    trimmed = true;
    const preview = label.slice(0, MAX_ELEMENT_TEXT_CHARS);
    return `${prefix}${preview}... [${label.length} chars]${suffix}`;
  });

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
