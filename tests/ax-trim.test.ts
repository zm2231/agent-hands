import { describe, it, expect } from "vitest";
import { trimAxTree, trimContentBlocks } from "../src/desktop/ax-trim.js";

describe("trimAxTree", () => {
  it("returns unchanged text when all values are short", () => {
    const tree = "\t1 button OK, Value: short\n\t2 button Cancel";
    const result = trimAxTree(tree);
    expect(result.trimmed).toBe(false);
    expect(result.text).toBe(tree);
  });

  it("caps long values in tab-indented tree format", () => {
    const longValue = "x".repeat(5000);
    const tree = "\t\t29 text entry area Description: Page 1 content, Value: " + longValue +
      "\n\t\t30 button OK";
    const result = trimAxTree(tree);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("x".repeat(200));
    expect(result.text).toContain("[5000 chars total]");
    expect(result.text).not.toContain("x".repeat(201));
    expect(result.text).toContain("30 button OK");
  });

  it("caps multiple long values independently", () => {
    const tree = [
      "\t29 text entry area Value: " + "a".repeat(3000),
      "\t30 text entry area Value: short",
      "\t31 text entry area Value: " + "b".repeat(4000),
    ].join("\n");
    const result = trimAxTree(tree);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("[3000 chars total]");
    expect(result.text).toContain("[4000 chars total]");
    expect(result.text).toContain("Value: short");
  });

  it("handles value at end of string without trailing newline", () => {
    const tree = "\t1 text Value: " + "z".repeat(500);
    const result = trimAxTree(tree);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("[500 chars total]");
  });
});

describe("trimContentBlocks", () => {
  it("passes through small text blocks unchanged", () => {
    const blocks = [
      { type: "text", text: "small" },
      { type: "image", data: "base64..." },
    ];
    const result = trimContentBlocks(blocks);
    expect(result).toEqual(blocks);
  });

  it("trims text blocks with long values and adds header", () => {
    const tree = "\t1 text Value: " + "x".repeat(5000) + "\n\t2 button OK";
    const blocks = [
      { type: "image", data: "screenshot" },
      { type: "text", text: tree },
    ];
    const result = trimContentBlocks(blocks);
    expect(result[0]).toEqual(blocks[0]);
    expect((result[1] as any).text).toContain("[AX tree trimmed:");
    expect((result[1] as any).text).toContain("[5000 chars total]");
  });

  it("includes tmp path in header when provided", () => {
    const tree = "\t1 text Value: " + "x".repeat(5000);
    const blocks = [{ type: "text", text: tree }];
    const result = trimContentBlocks(blocks, "/tmp/test.txt");
    expect((result[0] as any).text).toContain("/tmp/test.txt");
  });
});
