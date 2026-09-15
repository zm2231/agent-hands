import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNativeMessagingHostManifest } from "../src/browser/cdp/manifest.js";

describe("native messaging manifest discovery", () => {
  const previousDirectories = process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;
  const directories: string[] = [];

  afterEach(async () => {
    if (previousDirectories === undefined) delete process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;
    else process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS = previousDirectories;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("uses the environment-overridden search directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-manifest-"));
    directories.push(directory);
    process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS = directory;

    await expect(hasNativeMessagingHostManifest()).resolves.toBe(false);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "com.zmerchant.agenthands.json"), "{}");
    await expect(hasNativeMessagingHostManifest()).resolves.toBe(true);
  });
});
