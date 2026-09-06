// press_key normalization (xdotool syntax).

const ALIASES: Record<string, string> = {
  cmd: "Meta_L",
  command: "Meta_L",
  meta: "Meta_L",
  ctrl: "Control_L",
  control: "Control_L",
  shift: "Shift_L",
  alt: "Alt_L",
  option: "Alt_L",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};

export function normalizeKey(key: string): string {
  return key
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      const lower = trimmed.toLowerCase();
      if (ALIASES[lower]) return ALIASES[lower];
      // Single uppercase A-Z that is not an alias -> lowercase.
      if (/^[A-Z]$/.test(trimmed)) return trimmed.toLowerCase();
      return trimmed;
    })
    .join("+");
}
