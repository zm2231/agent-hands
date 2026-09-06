// Error and content sanitizing for agent-hands.

const HOME_RE = /\/Users\/[^/\s]+/g;
const URL_RE = /https?:\/\/[^\s)>]+/g;
const TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MAX_LEN = 500;

export function sanitizeError(msg: string): string {
  let s = msg
    .replace(HOME_RE, "~")
    .replace(URL_RE, "[url]")
    .replace(TOKEN_RE, "[redacted]")
    .replace(CONTROL_RE, "");
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + "…";
  return s;
}
