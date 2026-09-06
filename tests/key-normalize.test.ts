import { describe, it, expect } from "vitest";
import { normalizeKey } from "../src/desktop/os/key-normalize.js";

describe("normalizeKey", () => {
  it("normalizes modifier aliases", () => {
    expect(normalizeKey("cmd+c")).toBe("Meta_L+c");
    expect(normalizeKey("command+v")).toBe("Meta_L+v");
    expect(normalizeKey("ctrl+z")).toBe("Control_L+z");
    expect(normalizeKey("shift+a")).toBe("Shift_L+a");
    expect(normalizeKey("alt+tab")).toBe("Alt_L+tab");
    expect(normalizeKey("option+f")).toBe("Alt_L+f");
  });

  it("normalizes key name aliases", () => {
    expect(normalizeKey("enter")).toBe("Return");
    expect(normalizeKey("esc")).toBe("Escape");
    expect(normalizeKey("backspace")).toBe("BackSpace");
    expect(normalizeKey("arrowup")).toBe("Up");
    expect(normalizeKey("pagedown")).toBe("Page_Down");
  });

  it("lowercases single uppercase letters", () => {
    expect(normalizeKey("A")).toBe("a");
    expect(normalizeKey("Z")).toBe("z");
  });

  it("preserves already-correct keys", () => {
    expect(normalizeKey("Return")).toBe("Return");
    expect(normalizeKey("Tab")).toBe("Tab");
    expect(normalizeKey("KP_0")).toBe("KP_0");
  });

  it("handles compound keys", () => {
    expect(normalizeKey("cmd+shift+Z")).toBe("Meta_L+Shift_L+z");
    expect(normalizeKey("ctrl + alt + delete")).toBe("Control_L+Alt_L+Delete");
  });
});
