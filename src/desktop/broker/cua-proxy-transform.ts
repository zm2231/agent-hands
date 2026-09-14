export const STRIP_CAPABILITY = "codex/auth-change";

export function stripAuthChangeCapability(line: string): string {
  if (!line.trim()) return line;
  try {
    const msg = JSON.parse(line);
    const experimental = msg?.method === "initialize"
      ? msg?.params?.capabilities?.experimental
      : undefined;
    if (experimental && typeof experimental === "object" && STRIP_CAPABILITY in experimental) {
      delete experimental[STRIP_CAPABILITY];
      return JSON.stringify(msg);
    }
  } catch {}
  return line;
}
