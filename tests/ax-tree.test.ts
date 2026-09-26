import { describe, expect, it } from "vitest";
import { compactTree, findInTree, parseAxTree, parseTarget, readAxTree, resolveTarget } from "../src/desktop/ax-tree.js";

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

describe("state regions", () => {
  const STATE = [
    "Computer Use state (CUA App Version: 1)",
    "<app_specific_instructions>",
    "Prefer 3 tabs over 1 window.",
    "</app_specific_instructions>",
    "<app_state>",
    "App=/Applications/Test.app/ (bundleID com.test.app, pid 1)",
    "0 standard window W",
    "\t1 Description: Categories, Help: Pick one",
    "\t2 HTML content (settable) Description: message body, URL: about:blank",
    "\t3 row (selected) Inbox",
    "",
    "Selected:",
    "\t3 row (selected) Inbox",
    "",
    "Note: Pay special attention to the content selected by the user.",
    "The focused UI element is 2 HTML content (settable) Description: message body",
    "</app_state>",
  ].join("\n");

  it("separates instructions, elements, and trailing notes without duplicating selected elements", () => {
    const tree = readAxTree(STATE);
    expect(tree.nodes.map((n) => n.index)).toEqual(["0", "1", "2", "3"]);
    expect(tree.header.at(-1)).toBe("App=/Applications/Test.app/ (bundleID com.test.app, pid 1)");
    expect(tree.trailer.slice(0, 2)).toEqual(["", "Selected:"]);
    expect(tree.nodes[3].fields).toEqual({});
    expect(tree.diff).toBe(false);
    expect([...tree.header, ...tree.nodes.map((n) => `${"\t".repeat(n.depth)}${n.index} ${n.line}`), ...tree.trailer].join("\n")).toBe(STATE);
  });

  it("reads fields on elements with no role and after capitalized roles", () => {
    const [, noRole, html] = parseAxTree(STATE);
    expect(noRole.fields).toEqual({ Description: "Categories", Help: "Pick one" });
    expect(html.fields).toEqual({ Description: "message body", URL: "about:blank" });
    expect(resolveTarget(STATE, parseTarget({ name: "Inbox" }))).toMatchObject({ node: { index: "3" } });
    expect(resolveTarget(STATE, parseTarget({ name: "message body" }))).toMatchObject({ node: { index: "2" } });
  });

  it("reads trailer-like lines inside a value as value text when later elements follow", () => {
    const text = [
      "<app_state>",
      "0 standard window W",
      "\t1 text entry area Value: notes",
      "",
      "Selected:",
      "Note: Pay special attention to this line",
      "The focused UI element is not a real note",
      "\t2 button Reachable",
      "",
      "Selected:",
      "\t2 button Reachable",
      "The focused UI element is 2 button Reachable",
      "</app_state>",
    ].join("\n");
    const tree = readAxTree(text);
    expect(tree.nodes.map((n) => n.index)).toEqual(["0", "1", "2"]);
    expect(tree.nodes[1].line).toContain("Note: Pay special attention to this line");
    expect(tree.trailer).toEqual(["", "Selected:", "\t2 button Reachable", "The focused UI element is 2 button Reachable", "</app_state>"]);
    expect(resolveTarget(text, parseTarget({ name: "Reachable" }))).toMatchObject({ node: { index: "2" } });
    expect(findInTree(text, "reachable").split("\n")[0]).toBe('find "reachable": 1 of 3 elements');
    const compact = compactTree(text, 50, 0)!.text.split("\n");
    expect(compact.slice(0, 5)).toEqual(["<app_state>", "0 standard window W", "\t2 button Reachable", "\t… 1 more", ""]);
  });

  it("treats an element listed only after a Selected: line as a real element", () => {
    const text = ["<app_state>", "0 standard window W", "", "Selected:", "\t1 row Only Here", "</app_state>"].join("\n");
    const tree = readAxTree(text);
    expect(tree.nodes.map((n) => n.index)).toEqual(["0", "1"]);
    expect([...tree.header, ...tree.nodes.map((n) => `${"\t".repeat(n.depth)}${n.index} ${n.line}`), ...tree.trailer].join("\n")).toBe(text);
  });

  it("finds the trailer in linear time when values repeat marker lines", () => {
    const lines = ["<app_state>", "0 text entry area Value: start", ...Array.from({ length: 100_000 }, () => "Selected:"), "\t1 button End", "</app_state>"];
    const started = performance.now();
    const tree = readAxTree(lines.join("\n"));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(tree.nodes.map((n) => n.index)).toEqual(["0", "1"]);
  });

  const DIFF = [
    "Computer Use state (CUA App Version: 1)",
    "<app_state>",
    "App=/Applications/Test.app/ (bundleID com.test.app, pid 1)",
    "The following is a diff from the previous accessibility tree for Window: \"W\" with ~ and + representing changed and added elements, respectively.",
    "Removed element IDs: 4-6",
    "~\t\t7 button Save",
    "+\t\t9 button Save As",
    "</app_state>",
  ].join("\n");

  it("parses diff lines but refuses to resolve targets against a diff", () => {
    const tree = readAxTree(DIFF);
    expect(tree.diff).toBe(true);
    expect(tree.nodes.map((n) => [n.change, n.index, n.head])).toEqual([["~", "7", "button Save"], ["+", "9", "button Save As"]]);
    expect(resolveTarget(DIFF, parseTarget({ name: "Save" }))).toEqual({ error: expect.stringMatching(/^The app returned only the elements that changed/) });
  });

  it("labels find results from a diff as changed elements only", () => {
    expect(findInTree(DIFF, "save").split("\n")[0]).toBe('find "save": 2 of 2 changed elements (the app returned only what changed since an earlier read)');
  });

  it("never compacts a diff", () => {
    expect(compactTree(DIFF, 10, 0)).toBeNull();
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

describe("compactTree", () => {
  const RIBBON = [
    "Computer Use state (CUA App Version: 1)",
    "<app_state>",
    "App=/Applications/Test.app/ (bundleID com.test.app, pid 1)",
    "0 standard window W",
    "\t1 container Ribbon",
    "\t\t2 button Paste",
    "\t\t3 button Cut",
    "\t\t4 container",
    "\t\t\t5 button Bold",
    "\t\t\t6 text entry area Value: first line",
    "second line",
    "\t7 button Save",
    "</app_state>",
  ].join("\n");

  it("leaves trees at or under the threshold unchanged", () => {
    expect(compactTree(RIBBON, 60, RIBBON.length)).toBeNull();
  });

  it("keeps elements breadth-first within the budget and names hidden ones", () => {
    expect(compactTree(RIBBON, 85, 0)).toEqual({
      shown: 3,
      total: 8,
      text: [
        "Computer Use state (CUA App Version: 1)",
        "<app_state>",
        "App=/Applications/Test.app/ (bundleID com.test.app, pid 1)",
        "0 standard window W",
        "\t1 container Ribbon",
        "\t\t… 5 more: Paste, Cut, Bold",
        "\t7 button Save",
        "</app_state>",
      ].join("\n"),
    });
  });

  it("keeps multi-line values of shown elements intact", () => {
    const text = ["0 standard window W", "\t1 text entry area Value: first line", "second line", "\t2 group", "\t\t3 button Deep"].join("\n");
    expect(compactTree(text, 90, 0)).toEqual({
      text: ["0 standard window W", "\t1 text entry area Value: first line", "second line", "\t… 2 more: Deep"].join("\n"),
      shown: 2,
      total: 4,
    });
  });

  it("keeps instructions and trailing notes when compacting", () => {
    const text = ["<app_state>", "App=x", "0 standard window W", "\t1 group", "\t\t2 button Deep", "The focused UI element is 2 button Deep", "</app_state>"].join("\n");
    expect(compactTree(text, 40, 0)!.text).toBe(
      ["<app_state>", "App=x", "0 standard window W", "\t… 2 more: Deep", "The focused UI element is 2 button Deep", "</app_state>"].join("\n"),
    );
  });

  it("caps the names listed per hidden region", () => {
    const many = ["0 standard window W", "\t1 group", ...Array.from({ length: 30 }, (_, i) => `\t\t${i + 2} button Button number ${i}`)].join("\n");
    expect(compactTree(many, 150, 0)!.text.split("\n").pop()).toBe(
      "\t\t… 30 more: Button number 0, Button number 1, Button number 2, Button number 3, Button number 4, Button number 5, …",
    );
  });

  it("counts summary lines against the budget", () => {
    const groups = Array.from({ length: 80 }, (_, g) => [`\t${g * 6 + 1} group Section ${g}`, ...Array.from({ length: 5 }, (_, i) => `\t\t${g * 6 + i + 2} button Action ${g}-${i}`)]).flat();
    const text = ["<app_state>", "0 standard window W", ...groups, "</app_state>"].join("\n");
    const out = compactTree(text, 2000, 0)!;
    const body = out.text.split("\n").slice(1, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(out.shown).toBeGreaterThan(1);
  });

  it("compacts very wide trees without deep recursion or spreading children", () => {
    const text = ["<app_state>", "0 standard window W", ...Array.from({ length: 200_000 }, (_, i) => `\t${i + 1} button B${i}`), "</app_state>"].join("\n");
    const started = performance.now();
    const out = compactTree(text)!;
    expect(performance.now() - started).toBeLessThan(5000);
    expect(out.total).toBe(200_001);
    expect(out.text.split("\n").slice(1, -1).join("\n").length).toBeLessThanOrEqual(5000);
  });
});
