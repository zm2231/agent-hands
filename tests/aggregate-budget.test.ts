import { describe, it, expect } from "vitest";
import { applyAggregateBudget, type BrokerResult } from "../src/desktop/broker/dispatch.js";

describe("applyAggregateBudget", () => {
  function makeResult(sizeBytes: number, isError = false): BrokerResult {
    return {
      content: [{ type: "text", text: "x".repeat(sizeBytes) }],
      isError,
      modelTurnsStarted: 0,
      ephemeralThread: true,
    };
  }

  it("keeps all results when under budget", () => {
    const results = [makeResult(1000), makeResult(1000)];
    const capped = applyAggregateBudget(0, results, 25 * 1024 * 1024);
    expect(capped).toHaveLength(2);
    expect(capped[0].contentOmitted).toBeUndefined();
    expect(capped[1].contentOmitted).toBeUndefined();
    expect((capped[0].content[0] as any).text).toHaveLength(1000);
  });

  it("omits content when aggregate exceeds budget", () => {
    // Use 8 MB chunks to stay clearly within/over the 25 MB boundary.
    const results = [
      makeResult(8 * 1024 * 1024),  // 8 MB — primary(5)+8=13, under
      makeResult(8 * 1024 * 1024),  // 8 MB — 13+8=21, under
      makeResult(8 * 1024 * 1024),  // 8 MB — 21+8=29, over budget
    ];
    const primaryBytes = 5 * 1024 * 1024;
    const capped = applyAggregateBudget(primaryBytes, results, 25 * 1024 * 1024);

    expect(capped).toHaveLength(3);
    expect(capped[0].contentOmitted).toBeUndefined();
    expect(capped[1].contentOmitted).toBeUndefined();
    expect(capped[2].contentOmitted).toBe(true);
    expect((capped[2].content[0] as any).text).toContain("omitted");
  });

  it("preserves isError on omitted results", () => {
    const results = [
      makeResult(5 * 1024 * 1024),         // 5 MB — primary(5)+5=10, under
      makeResult(20 * 1024 * 1024, true),   // 20 MB, error — 10+20=30, over
    ];
    const capped = applyAggregateBudget(5 * 1024 * 1024, results, 25 * 1024 * 1024);
    expect(capped[0].contentOmitted).toBeUndefined();
    expect(capped[1].contentOmitted).toBe(true);
    expect(capped[1].isError).toBe(true);
  });

  it("preserves count of all results regardless of budget", () => {
    const results = Array.from({ length: 19 }, (_, i) =>
      makeResult(5 * 1024 * 1024, i === 18)
    );
    const capped = applyAggregateBudget(5 * 1024 * 1024, results, 25 * 1024 * 1024);
    expect(capped).toHaveLength(19); // All present
    // Some should be omitted (after ~4 results at 5 MB each)
    const omitted = capped.filter((r) => r.contentOmitted);
    expect(omitted.length).toBeGreaterThan(0);
    // Last result's error preserved
    expect(capped[18].isError).toBe(true);
  });

  it("total retained content is bounded", () => {
    const results = Array.from({ length: 19 }, () =>
      makeResult(5 * 1024 * 1024)
    );
    const capped = applyAggregateBudget(5 * 1024 * 1024, results, 25 * 1024 * 1024);
    const totalBytes = capped.reduce((sum, r) =>
      sum + Buffer.byteLength(JSON.stringify(r.content), "utf8"), 0
    );
    // Total should be around 25 MB (primary 5 MB + ~4 follow-ups at 5 MB each)
    // plus small placeholder texts for the rest
    expect(totalBytes).toBeLessThanOrEqual(26 * 1024 * 1024); // Allow small overhead
  });
});
