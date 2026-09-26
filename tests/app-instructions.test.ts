import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_REPEAT_MS, presentInstructions as present } from "../src/desktop/app-instructions.js";

const presentInstructions = (text: string, app: string, force: boolean, now: number) => {
  const presented = present(text, app, force, now);
  presented.markShown();
  return presented.text;
};

const state = (body: string) =>
  ["Computer Use state (CUA App Version: 1)", "<app_specific_instructions>", "## Notes Computer Use", "", body, "</app_specific_instructions>", "<app_state>", "0 standard window W", "</app_state>"].join("\n");
const POINTER = /^Computer Use state \(CUA App Version: 1\)\n\[Notes Computer Use: app instructions shown (under a minute|\d+ min) ago; pass instructions: true to include them again\]\n<app_state>\n0 standard window W\n<\/app_state>$/;

describe("presentInstructions", () => {
  it("shows the block the first time and a pointer on repeat reads", () => {
    const text = state("Press Return to edit.");
    expect(presentInstructions(text, "app.first", false, 0)).toBe(text);
    expect(presentInstructions(text, "app.first", false, 30_000)).toMatch(POINTER);
    expect(presentInstructions(text, "app.first", false, 3 * 60_000)).toContain("shown 3 min ago");
  });

  it("shows the block again when it changes, when forced, or after the repeat interval", () => {
    const text = state("Press Return to edit.");
    presentInstructions(text, "app.again", false, 0);
    const changed = state("Press Tab to edit.");
    expect(presentInstructions(changed, "app.again", false, 1000)).toBe(changed);
    expect(presentInstructions(changed, "app.again", true, 2000)).toBe(changed);
    expect(presentInstructions(changed, "app.again", false, 3000)).toMatch(POINTER);
    expect(presentInstructions(changed, "app.again", false, 2000 + INSTRUCTIONS_REPEAT_MS)).toBe(changed);
  });

  it("tracks apps separately and leaves text without a block unchanged", () => {
    const text = state("Press Return to edit.");
    presentInstructions(text, "app.one", false, 0);
    expect(presentInstructions(text, "app.two", false, 1000)).toBe(text);
    expect(presentInstructions("<app_state>\n0 window\n</app_state>", "app.one", false, 1000)).toBe("<app_state>\n0 window\n</app_state>");
  });

  it("restores the last block on request when a read arrives without one", () => {
    const text = state("Press Return to edit.");
    presentInstructions(text, "app.restore", false, 0);
    const bare = "Computer Use state (CUA App Version: 1)\n<app_state>\n0 standard window W\n</app_state>";
    expect(presentInstructions(bare, "app.restore", false, 1000)).toBe(bare);
    expect(presentInstructions(bare, "app.restore", true, 2000)).toBe(text);
    expect(presentInstructions(bare, "app.never-seen", true, 2000)).toBe(bare);
  });

  it("does not count a block as shown until the caller marks it", () => {
    const text = state("Press Return to edit.");
    present(text, "app.unmarked", false, 0);
    expect(present(text, "app.unmarked", false, 1000).text).toBe(text);
  });
});
