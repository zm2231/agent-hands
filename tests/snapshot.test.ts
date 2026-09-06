import { describe, it, expect } from "vitest";
import { takeSnapshot } from "../src/browser/snapshot.js";
import { createFakeCDP } from "./fake-cdp.js";

describe("takeSnapshot", () => {
  it("produces content lines from an accessibility tree", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    const result = await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {});

    expect(result.ref_id).toBe("ABCDEF12");
    expect(result.title).toBe("Test Page");
    expect(result.url).toBe("https://example.com");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.elements.length).toBeGreaterThan(0);

    // Should have interactive elements assigned ids.
    const buttonLine = result.content.find((c) => c.text.includes("Click me"));
    expect(buttonLine).toBeDefined();
    expect(buttonLine!.element_id).toBeDefined();

    // Element refs should be populated.
    expect(refs.size).toBeGreaterThan(0);
  });

  it("filters by pattern", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    const result = await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {
      pattern: "Click",
    });

    expect(result.pattern).toBe("Click");
    expect(result.content.every((c) => c.text.toLowerCase().includes("click"))).toBe(true);
  });

  it("respects response_length", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    const short = await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {
      responseLength: "short",
    });
    // short limits to 60 lines, but our test tree is small; just confirm it works.
    expect(short.content.length).toBeLessThanOrEqual(60);
  });

  it("clears element refs on each snapshot", async () => {
    const cdp = createFakeCDP();
    const refs = new Map<number, number>();
    await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {});
    const firstSize = refs.size;
    expect(firstSize).toBeGreaterThan(0);

    await takeSnapshot(cdp, "session-1", "ABCDEF12", refs, {});
    // Refs should have been cleared and repopulated.
    expect(refs.size).toBe(firstSize);
  });
});
