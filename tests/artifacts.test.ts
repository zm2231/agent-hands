import { describe, it, expect } from "vitest";
import { storeText, readResult, discardResult, saveScreenshot } from "../src/browser/artifacts.js";
import { unlink } from "node:fs/promises";

describe("artifacts", () => {
  it("returns inline text for small content", async () => {
    const result = await storeText("hello world");
    expect(result.inline).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.handle).toBeUndefined();
  });

  it("stores and retrieves large text via handle", async () => {
    const bigText = "x".repeat(50_000);
    const stored = await storeText(bigText);
    expect(stored.truncated).toBe(true);
    expect(stored.handle).toBeDefined();
    expect(stored.inline.length).toBeLessThan(bigText.length);

    // Read back.
    const chunk = await readResult(stored.handle!, stored.nextOffset);
    expect(chunk.handle).toBe(stored.handle);
    expect(chunk.text.length).toBeGreaterThan(0);
  });

  it("rejects unknown handles", async () => {
    await expect(readResult("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      "Result handle not found"
    );
  });

  it("saves screenshots to disk", async () => {
    const path = await saveScreenshot(Buffer.from("fakepng"), "ABCDEF12");
    expect(path).toContain("browser-");
    expect(path).toContain(".png");
    // Clean up.
    await unlink(path).catch(() => {});
  });
});
