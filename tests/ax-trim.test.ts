import { describe, it, expect } from "vitest";
import { trimAxTree, trimContentBlocks } from "../src/desktop/ax-trim.js";

describe("trimAxTree", () => {
  it("returns unchanged text when values are short", () => {
    const small = "  [0] AXWindow \"Test\"\n  Value: short";
    const result = trimAxTree(small);
    expect(result.trimmed).toBe(false);
    expect(result.text).toBe(small);
  });

  it("caps long Value: lines regardless of total size", () => {
    const longValue = "x".repeat(5000);
    const tree = "  [0] AXWindow \"Test\"\n" +
      "  Value: " + longValue + "\n" +
      "  [1] AXButton \"OK\"\n";
    const result = trimAxTree(tree);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("x".repeat(200));
    expect(result.text).toContain("[5000 chars total]");
    expect(result.text).not.toContain("x".repeat(201));
  });

  it("preserves short Value: lines", () => {
    const tree = "  Value: short text\n  [1] AXButton \"OK\"\n";
    const result = trimAxTree(tree);
    expect(result.trimmed).toBe(false);
    expect(result.text).toBe(tree);
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
    const longValue = "x".repeat(5000);
    const tree = "  [0] AXTextArea \"Page\"\n  Value: " + longValue + "\n";
    const blocks = [
      { type: "image", data: "screenshot" },
      { type: "text", text: tree },
    ];
    const result = trimContentBlocks(blocks);
    expect(result[0]).toEqual(blocks[0]);
    expect((result[1] as any).text).toContain("[AX tree trimmed:");
    expect((result[1] as any).text).toContain("[5000 chars total]");
    expect((result[1] as any).text.length).toBeLessThan(tree.length);
  });

  it("includes tmp path in header when provided", () => {
    const tree = "  Value: " + "x".repeat(5000) + "\n";
    const blocks = [{ type: "text", text: tree }];
    const result = trimContentBlocks(blocks, "/tmp/test.txt");
    expect((result[0] as any).text).toContain("/tmp/test.txt");
  });
});
