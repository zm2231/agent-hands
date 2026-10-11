import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppIdentity } from "../src/desktop/os/identity.js";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string></dict></plist>`;

describe.skipIf(process.platform !== "darwin")("resolveAppIdentity", () => {
  let dir: string;
  let appPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hands-identity-"));
    appPath = join(dir, "Example.app");
    await mkdir(join(appPath, "Contents"), { recursive: true });
    await writeFile(join(appPath, "Contents", "Info.plist"), PLIST);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("targets an app given by path by its resolved path, so copies sharing a bundle id stay distinct", async () => {
    const identity = await resolveAppIdentity(appPath);
    expect(identity).toEqual({
      bundleId: "com.example.app",
      leaseId: "com.example.app",
      target: await realpath(appPath),
    });
  });

  it("has no target for a path without a bundle", async () => {
    const identity = await resolveAppIdentity(join(dir, "Missing.app"));
    expect(identity.bundleId).toBeNull();
    expect(identity.target).toBeNull();
  });
});
