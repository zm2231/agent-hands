import { describe, it, expect } from "vitest";
import { createFakeCDP } from "./fake-cdp.js";
import { clickAction } from "../src/browser/actions/click.js";
import { typeAction } from "../src/browser/actions/type.js";
import { pressKeyAction, parseKey } from "../src/browser/actions/press-key.js";
import { navigateAction } from "../src/browser/actions/navigate.js";
import { evaluateAction } from "../src/browser/actions/evaluate.js";
import { htmlAction } from "../src/browser/actions/html.js";
import { networkAction } from "../src/browser/actions/network.js";
import { rawAction } from "../src/browser/actions/raw.js";
import { helpAction } from "../src/browser/actions/help.js";

describe("click action", () => {
  it("clicks by element id", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>([[1, 101]]);
    const result = await clickAction(cdp, "s1", refs, { id: 1 });
    expect(result).toContain("Clicked element 1");
  });

  it("clicks by coordinates", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    const result = await clickAction(cdp, "s1", refs, { x: 100, y: 200 });
    expect(result).toContain("Clicked at CSS (100, 200)");
  });

  it("rejects unknown element id", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    await expect(clickAction(cdp, "s1", refs, { id: 99 })).rejects.toThrow(
      "Unknown element id 99"
    );
  });

  it("requires id, selector, or coordinates", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    await expect(clickAction(cdp, "s1", refs, {})).rejects.toThrow(
      "click requires"
    );
  });
});

describe("type action", () => {
  it("types by element id", async () => {
    const cdp = createFakeCDP([
      {
        method: "Runtime.callFunctionOn",
        sessionFilter: "s1",
        result: { result: { value: { tag: "INPUT", before: "" } } },
      },
    ]);
    const refs = new Map<number, number>([[1, 102]]);
    const result = await typeAction(cdp, "s1", refs, { id: 1, text: "hello" });
    expect(result).toContain("Typed 5 characters");
  });
});

function recordKeys(cdp: ReturnType<typeof createFakeCDP>) {
  const events: Record<string, unknown>[] = [];
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params, sessionId) => {
    if (method === "Input.dispatchKeyEvent") events.push(params ?? {});
    return send(method, params, sessionId);
  };
  return events;
}

describe("press_key action", () => {
  it("presses Enter with text so forms submit", async () => {
    const cdp = createFakeCDP();
    const events = recordKeys(cdp);
    const result = await pressKeyAction(cdp, "s1", new Map(), { key: "Enter" });
    expect(result).toBe("Pressed Enter");
    expect(events).toEqual([
      { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, type: "keyDown", text: "\r" },
      { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, type: "keyUp" },
    ]);
  });

  it("sends modifier chords without text", async () => {
    const cdp = createFakeCDP();
    const events = recordKeys(cdp);
    await pressKeyAction(cdp, "s1", new Map(), { key: "Cmd+a" });
    expect(events[0]).toMatchObject({ key: "a", code: "KeyA", modifiers: 4, type: "rawKeyDown", text: undefined });
    expect(parseKey("Shift+Tab")).toMatchObject({ def: { key: "Tab" }, modifiers: 8 });
  });

  it("focuses the element first when given an id", async () => {
    const cdp = createFakeCDP([
      { method: "Runtime.callFunctionOn", sessionFilter: "s1", result: { result: { value: true } } },
    ]);
    const result = await pressKeyAction(cdp, "s1", new Map([[3, 103]]), { key: "Escape", id: 3 });
    expect(result).toBe("Pressed Escape in element 3");
  });

  it("rejects unknown keys and modifiers", () => {
    expect(() => parseKey("Hyper+a")).toThrow('Unknown modifier "Hyper"');
    expect(() => parseKey("Launch")).toThrow('Unknown key "Launch"');
  });
});

describe("navigate action", () => {
  it("navigates to a URL", async () => {
    const cdp = createFakeCDP([
      { method: "Page.navigate", result: {} },  // No loaderId = skip load event wait
    ]);
    const result = await navigateAction(cdp, "s1", { url: "https://example.com" });
    expect(result).toContain("Navigated to https://example.com");
  });

  it("rejects non-http URLs", async () => {
    const cdp = createFakeCDP();
    await expect(navigateAction(cdp, "s1", { url: "ftp://bad" })).rejects.toThrow(
      "http or https"
    );
  });
});

describe("evaluate action", () => {
  it("evaluates an expression", async () => {
    const cdp = createFakeCDP([
      {
        method: "Runtime.evaluate",
        result: { result: { value: 42 } },
      },
    ]);
    const result = await evaluateAction(cdp, "s1", { expression: "1+1" });
    expect(result).toBe("42");
  });

  it("throws on evaluation errors", async () => {
    const cdp = createFakeCDP([
      {
        method: "Runtime.evaluate",
        result: {
          result: {},
          exceptionDetails: { text: "SyntaxError", exception: { description: "bad syntax" } },
        } as any,
      },
    ]);
    await expect(evaluateAction(cdp, "s1", { expression: "???" })).rejects.toThrow("bad syntax");
  });
});

describe("html action", () => {
  it("returns full page HTML by default", async () => {
    const cdp = createFakeCDP([
      {
        method: "Runtime.evaluate",
        result: { result: { value: "<html><body>test</body></html>" } },
      },
    ]);
    const result = await htmlAction(cdp, "s1", new Map(), {});
    expect(result).toContain("<html>");
  });
});

describe("network action", () => {
  it("returns formatted network entries", async () => {
    const cdp = createFakeCDP([
      {
        method: "Runtime.evaluate",
        result: {
          result: {
            value: JSON.stringify([
              { name: "https://example.com/style.css", type: "link", duration: 50, size: 1024 },
            ]),
          },
        },
      },
    ]);
    const result = await networkAction(cdp, "s1");
    expect(result).toContain("style.css");
    expect(result).toContain("link");
  });
});

describe("raw action", () => {
  it("sends arbitrary CDP method", async () => {
    const cdp = createFakeCDP([
      { method: "DOM.getDocument", result: { root: { nodeId: 1 } } },
    ]);
    const result = await rawAction(cdp, "s1", { method: "DOM.getDocument" });
    expect(result).toContain("nodeId");
  });

  it("rejects empty method", async () => {
    const cdp = createFakeCDP();
    await expect(rawAction(cdp, "s1", { method: "" })).rejects.toThrow("CDP method required");
  });
});

describe("help action", () => {
  it("returns action map", () => {
    const result = helpAction();
    expect(result.actions).toBeDefined();
    expect(Object.keys(result.actions as object)).toContain("click");
    expect(Object.keys(result.actions as object)).toContain("tabs");
    expect(Object.keys(result.actions as object)).toEqual(expect.arrayContaining(["press_key", "close"]));
  });
});
