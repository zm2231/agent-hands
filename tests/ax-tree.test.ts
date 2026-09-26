import { describe, expect, it } from "vitest";
import { findInTree, parseAxTree, parseTarget, resolveTarget } from "../src/desktop/ax-tree.js";

const TREE = [
  "Computer Use state (CUA App Version: 1)",
  "<app_state>",
  "App=/Applications/Test.app/ (bundleID com.test.app, pid 1)",
  "0 standard window Report, ID: main, Secondary Actions: Raise",
  "\t1 container Status Bar",
  "\t\t2 button Zoom Out",
  "\t\t3 button Zoom In",
  "\t\t4 slider (settable, float) Help: Zoom, Value: 1050, Details: 120%",
  "\t5 tab group Description: ribbon, Details: Home",
  "\t\t6 toggle button Bold, Value: off",
  "\t\t7 button (disabled) Cut, Value: 0",
  "\t\t8 button Description: close, Help: Close the Sidebar",
  "\t\t9 text entry area (settable) Description: Page 1 content, Value: First line",
  "second line of the same value",
  "\t10 outline sidebar",
  "\t\t11 row (selectable) Description: document, Value: Documents",
  "\t\t12 row (selectable) Downloads",
  "\t\t13 text ‎42",
  "\t\t14 button Description: 7, ID: Seven",
  "</app_state>",
].join("\n");

const target = (t: Record<string, unknown>) => parseTarget(t);
const resolved = (t: Record<string, unknown>) => {
  const r = resolveTarget(TREE, target(t));
  return "node" in r ? r.node.index : r.error;
};

describe("parseAxTree", () => {
  it("parses indexes, depth, parents, fields, and continuation lines", () => {
    const nodes = parseAxTree(TREE);
    expect(nodes.map((n) => n.index)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
    const bold = nodes.find((n) => n.index === "6")!;
    expect(bold.parent!.index).toBe("5");
    expect(bold.head).toBe("toggle button Bold");
    expect(bold.fields.Value).toBe("off");
    const area = nodes.find((n) => n.index === "9")!;
    expect(area.line).toContain("second line of the same value");
    expect(nodes.find((n) => n.index === "13")!.head).toBe("text 42");
  });
});

describe("resolveTarget", () => {
  it("matches exact names with or without a role", () => {
    expect(resolved({ name: "Bold" })).toBe("6");
    expect(resolved({ role: "toggle button", name: "bold" })).toBe("6");
    expect(resolved({ role: "button", name: "Zoom In" })).toBe("3");
  });

  it("matches description, value, and ID labels", () => {
    expect(resolved({ name: "close" })).toBe("8");
    expect(resolved({ name: "Documents" })).toBe("11");
    expect(resolved({ role: "row", name: "Downloads" })).toBe("12");
    expect(resolved({ name: "Seven" })).toBe("14");
    expect(resolved({ name: "42" })).toBe("13");
  });

  it("does not match a trailing part of a name", () => {
    expect(resolved({ name: "In" })).toMatch(/^No element matches "In"/);
    expect(resolved({ name: "line" })).toMatch(/^No element matches "line"/);
  });

  it("does not let a role match a longer role", () => {
    expect(resolved({ role: "button", name: "Bold" })).toMatch(/^No element matches button "Bold"/);
  });

  it("refuses ambiguous matches and lists candidates with paths", () => {
    const error = resolved({ name: "zoom", match: "contains" }) as string;
    expect(error).toMatch(/^2 elements match "zoom" \(contains\); nothing was done/);
    expect(error).toContain("2 button Zoom Out  [container Status Bar]");
    expect(error).toContain("3 button Zoom In  [container Status Bar]");
  });

  it("refuses missing matches and suggests similar elements", () => {
    const error = resolved({ name: "Zoom" }) as string;
    expect(error).toMatch(/^No element matches "Zoom"; nothing was done/);
    expect(error).toContain("Similar elements:");
    expect(error).toContain("2 button Zoom Out");
  });
});

describe("line grammar", () => {
  const tree = (...lines: string[]) => ["<app_state>", "0 standard window W", ...lines.map((l) => `\t${l}`), "</app_state>"].join("\n");
  const resolveIn = (text: string, t: Record<string, unknown>) => {
    const r = resolveTarget(text, parseTarget(t));
    return "node" in r ? r.node.index : r.error;
  };

  it("keeps element indexes exactly as rendered", () => {
    expect(resolveIn(tree("9007199254740993 button Save"), { name: "Save" })).toBe("9007199254740993");
  });

  it("keeps parentheses that are part of a name", () => {
    const text = tree("1 button English (United States), Help: Language", "2 button Export (PDF)");
    expect(resolveIn(text, { name: "English (United States)" })).toBe("1");
    expect(resolveIn(text, { role: "button", name: "Export (PDF)" })).toBe("2");
    expect(resolveIn(text, { name: "English" })).toMatch(/^No element matches/);
    expect(resolveIn(text, { role: "button", name: "Export" })).toMatch(/^No element matches/);
  });

  it("strips only known flags directly after the role", () => {
    const text = tree("1 button (disabled, weird) Save", "2 row (selectable, expanded) Value: Favorites", "3 button back (selected)");
    expect(resolveIn(text, { name: "Save" })).toMatch(/^No element matches/);
    expect(resolveIn(text, { name: "Favorites" })).toBe("2");
    expect(resolveIn(text, { name: "back (selected)" })).toBe("3");
  });

  it("reads field-like text inside a name or field as literal text", () => {
    const text = tree("1 button Report Description: Publish", "2 button Save, Help: Enter Value: here");
    expect(resolveIn(text, { name: "Publish" })).toMatch(/^No element matches/);
    expect(resolveIn(text, { name: "Report Description: Publish" })).toBe("1");
    const save = parseAxTree(text).find((n) => n.index === "2")!;
    expect(save.fields).toEqual({ Help: "Enter Value: here" });
  });

  it("reads fields after app-defined roles and names without a role", () => {
    const text = tree("1 change calculator mode Description: Change Mode, ID: Mode: basic", "2 Edit, ID: EditMenu_MenuItem", "3 outline sidebar");
    expect(resolveIn(text, { name: "Change Mode" })).toBe("1");
    expect(parseAxTree(text).find((n) => n.index === "1")!.fields.ID).toBe("Mode: basic");
    expect(resolveIn(text, { name: "Edit" })).toBe("2");
    expect(resolveIn(text, { name: "sidebar" })).toBe("3");
    expect(resolveIn(text, { role: "outline", name: "sidebar" })).toBe("3");
  });
});

describe("parseTarget", () => {
  it.each([
    [null, "target must be an object with a name."],
    [{ name: "" }, "target.name must be a non-empty string."],
    [{ name: "x", role: 3 }, "target.role must be a non-empty string."],
    [{ name: "x", match: "fuzzy" }, 'target.match must be "exact" or "contains".'],
    [{ name: "x", index: 1 }, "Unknown target field(s): index"],
  ])("rejects %o", (value, message) => {
    expect(() => parseTarget(value)).toThrow(message);
  });

  it("defaults to exact matching", () => {
    expect(parseTarget({ name: "Bold" })).toEqual({ role: undefined, name: "Bold", match: "exact" });
  });
});

describe("findInTree", () => {
  it("returns matching elements with parent paths, searching help text too", () => {
    expect(findInTree(TREE, "zoom")).toBe([
      'find "zoom": 3 of 15 elements',
      "2 button Zoom Out  [container Status Bar]",
      "3 button Zoom In  [container Status Bar]",
      "4 slider (settable, float) Help: Zoom, Value: 1050, Details: 120%  [container Status Bar]",
    ].join("\n"));
  });

  it("caps results and reports the remainder", () => {
    expect(findInTree(TREE, "button", 2).split("\n")).toEqual([
      'find "button": 6 of 15 elements',
      "2 button Zoom Out  [container Status Bar]",
      "3 button Zoom In  [container Status Bar]",
      "…4 more; narrow the query",
    ]);
  });

  it("reports no matches", () => {
    expect(findInTree(TREE, "nothing here")).toBe('find "nothing here": 0 of 15 elements');
  });
});
