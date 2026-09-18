import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runningVersion } from "../src/version.js";

describe("extension manifest version", () => {
  it("matches the package version", async () => {
    const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe(runningVersion());
  });
});
