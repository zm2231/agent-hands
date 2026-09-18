import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configDir, launcherPath, manifestJson, writeLauncher } from "../host/manifest.mjs";

describe("native-messaging manifest launcher", () => {
  const directories: string[] = [];
  const originalConfigHome = process.env.XDG_CONFIG_HOME;
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
  });

  it("emits an executable deterministic launcher for the persistent browser broker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-hands-manifest-"));
    directories.push(directory);
    process.env.XDG_CONFIG_HOME = directory;
    const launcher = await writeLauncher(resolve("host/native-host.mjs"));
    expect(launcher).toBe(launcherPath());
    expect(launcher.startsWith(configDir())).toBe(true);
    await expect(access(launcher, constants.X_OK)).resolves.toBeUndefined();
    expect(manifestJson(launcher, ["abc"])).toMatchObject({ path: launcher, allowed_origins: ["chrome-extension://abc/"] });
    expect(await readFile(launcher, "utf8")).toContain(process.execPath);
  });
});
