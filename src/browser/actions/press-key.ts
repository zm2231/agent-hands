import type { CDPClient } from "../cdp/types.js";
import { resolveElement, releaseObject } from "./element-resolve.js";

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const KEY_ALIASES: Record<string, string> = {
  return: "enter", esc: "escape", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright",
};

const MODIFIERS: Record<string, number> = {
  alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8,
};

export interface ParsedKey {
  def: KeyDef;
  modifiers: number;
}

export function parseKey(spec: string): ParsedKey {
  const literalPlus = spec === "+" || spec.endsWith("++");
  const parts = literalPlus ? (spec === "+" ? [] : spec.slice(0, -2).split("+")) : spec.split("+");
  const name = literalPlus ? "+" : (parts.pop() ?? "").trim();
  let modifiers = 0;
  for (const raw of parts) {
    const part = raw.trim();
    const bit = MODIFIERS[part.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${part}" in key "${spec}".`);
    modifiers |= bit;
  }
  const lower = name.toLowerCase();
  const named = NAMED_KEYS[KEY_ALIASES[lower] ?? lower];
  if (named) return { def: named, modifiers };
  if (/^F([1-9]|1[0-2])$/i.test(name)) {
    const n = Number(name.slice(1));
    return { def: { key: `F${n}`, code: `F${n}`, keyCode: 111 + n }, modifiers };
  }
  if ([...name].length === 1) {
    const letter = /^[A-Za-z]$/.test(name);
    const digit = /^[0-9]$/.test(name);
    const code = letter ? `Key${name.toUpperCase()}` : digit ? `Digit${name}` : "";
    const keyCode = letter || digit ? name.toUpperCase().charCodeAt(0) : 0;
    return { def: { key: name, code, keyCode, text: name }, modifiers };
  }
  throw new Error(`Unknown key "${name}". Use a single character or a named key such as Enter, Tab, Escape, ArrowDown.`);
}

export async function pressKeyAction(
  cdp: CDPClient,
  sessionId: string,
  elementRefs: Map<number, number>,
  args: Record<string, unknown>
): Promise<string> {
  const { def, modifiers } = parseKey(args.key as string);
  const id = args.id as number | undefined;

  if (id != null) {
    const { objectId } = await resolveElement(cdp, sessionId, elementRefs, id);
    try {
      const focused = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          'function(){this.scrollIntoView({block:"center",inline:"center"});this.focus({preventScroll:true});return document.activeElement===this}',
        returnByValue: true,
      }, sessionId);
      if ((focused.result as any)?.value !== true) throw new Error("Could not focus element");
    } finally {
      await releaseObject(cdp, sessionId, objectId);
    }
  }

  const text = modifiers & (2 | 4) ? undefined : def.text;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, sessionId);

  return `Pressed ${args.key as string}${id != null ? ` in element ${id}` : ""}`;
}
