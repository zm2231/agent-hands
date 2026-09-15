import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STABLE_INSTALL_MESSAGE,
  browserHostDirectoriesFor,
  browserHostStatus,
  installBrowserHost,
  readBrowserHostRecord,
  uninstallBrowserHost,
  validateExtensionId,
} from "../src/browser/host-installer.js";
import { nativeMessagingHostDirectoriesFor, type NativeMessagingHostDirectory } from "../src/browser/cdp/manifest.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const secondExtensionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function installRecordPath(dataHome: string): string {
  return join(dataHome, "agent-hands", "browser-host-install.json");
}

async function removeInstalledTargets(dataHome: string): Promise<void> {
  const path = installRecordPath(dataHome);
  const record = JSON.parse(await readFile(path, "utf8"));
  delete record.installedTargets;
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function removeInstallRecord(dataHome: string): Promise<void> {
  await rm(installRecordPath(dataHome));
}

async function corruptInstallRecord(dataHome: string): Promise<void> {
  await writeFile(installRecordPath(dataHome), "not json\n");
}

async function updateInstallRecord(dataHome: string, update: (record: Record<string, unknown>) => void): Promise<void> {
  const path = installRecordPath(dataHome);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  update(record);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function fixture(): Promise<{
  root: string;
  hostPath: string;
  nodePath: string;
  directories: NativeMessagingHostDirectory[];
  dataHome: string;
  writeLauncher(hostPath: string, nodePath: string): Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-hands-installer-"));
  await mkdir(join(root, ".git"));
  const hostPath = join(root, "host", "native-host.mjs");
  const nodePath = join(root, "node");
  await mkdir(join(root, "host"), { recursive: true });
  await writeFile(hostPath, "export {};\n");
  await writeFile(nodePath, "node\n");
  const directories = [
    { browser: "chrome" as const, directory: join(root, "chrome") },
    { browser: "brave" as const, directory: join(root, "brave") },
  ];
  const dataHome = join(root, "data");
  return {
    root,
    hostPath,
    nodePath,
    directories,
    dataHome,
    async writeLauncher(writtenHostPath, writtenNodePath) {
      const launcher = join(root, "launcher");
      await writeFile(launcher, `${writtenNodePath}\n${writtenHostPath}\n`);
      return launcher;
    },
  };
}

describe("browser host installer", () => {
  const roots: string[] = [];
  const originalHostPath = process.env.AGENT_HANDS_HOST_PATH;
  const originalManifestDirectories = process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    if (originalHostPath === undefined) delete process.env.AGENT_HANDS_HOST_PATH;
    else process.env.AGENT_HANDS_HOST_PATH = originalHostPath;
    if (originalManifestDirectories === undefined) delete process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;
    else process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS = originalManifestDirectories;
  });

  it("validates extension IDs", () => {
    expect(() => validateExtensionId(extensionId)).not.toThrow();
    expect(() => validateExtensionId("invalid")).toThrow("Invalid extension ID");
  });

  it("writes manifests, merges origins, and remains idempotent", async () => {
    const f = await fixture();
    roots.push(f.root);
    const options = { browser: "all" as const, extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher, version: "0.4.0" };
    const first = await installBrowserHost(options);
    expect(first.at(-1)).toBe("reload the extension and restart the browser");
    await installBrowserHost({ ...options, extensionId: secondExtensionId });
    await installBrowserHost({ ...options, extensionId: secondExtensionId });
    for (const { directory } of f.directories) {
      const manifest = JSON.parse(await readFile(join(directory, "com.zmerchant.agenthands.json"), "utf8"));
      expect(manifest.allowed_origins).toEqual([
        `chrome-extension://${extensionId}/`,
        `chrome-extension://${secondExtensionId}/`,
      ]);
    }
    await expect(access(join(f.root, "launcher"))).resolves.toBeUndefined();
  });

  it("refuses npx cache paths and accepts source and global paths", async () => {
    const f = await fixture();
    roots.push(f.root);
    const npxHost = join(f.root, "_npx", "host", "native-host.mjs");
    await mkdir(join(f.root, "_npx", "host"), { recursive: true });
    await writeFile(npxHost, "export {};\n");
    await expect(installBrowserHost({ extensionId, hostPath: npxHost, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).rejects.toThrow(STABLE_INSTALL_MESSAGE);
    await expect(installBrowserHost({ extensionId, hostPath: f.hostPath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).resolves.toBeTruthy();
    const globalHost = join(f.root, "global", "agent-hands", "host", "native-host.mjs");
    await mkdir(join(f.root, "global", "agent-hands", "host"), { recursive: true });
    await writeFile(globalHost, "export {};\n");
    await expect(installBrowserHost({ extensionId, hostPath: globalHost, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher, npmRoot: async () => join(f.root, "global") })).resolves.toBeTruthy();
  });

  it("refuses a source-checkout symlink whose target is in an npx cache", async () => {
    const f = await fixture();
    roots.push(f.root);
    const npxHost = join(f.root, "_npx", "host", "native-host.mjs");
    const linkedHost = join(f.root, "host", "linked-native-host.mjs");
    await mkdir(join(f.root, "_npx", "host"), { recursive: true });
    await writeFile(npxHost, "export {};\n");
    await symlink(npxHost, linkedHost);
    await expect(installBrowserHost({ extensionId, hostPath: linkedHost, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).rejects.toThrow(STABLE_INSTALL_MESSAGE);
    await expect(installBrowserHost({ extensionId, hostPath: f.hostPath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).resolves.toBeTruthy();
  });

  it("accepts explicit and environment host-path overrides", async () => {
    const f = await fixture();
    roots.push(f.root);
    process.env.AGENT_HANDS_HOST_PATH = f.hostPath;
    process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS = join(f.root, "override");
    await expect(installBrowserHost({ extensionId, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).resolves.toBeTruthy();
    await expect(access(join(f.root, "override", "com.zmerchant.agenthands.json"))).resolves.toBeUndefined();
    await expect(installBrowserHost({ extensionId, hostPath: f.hostPath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).resolves.toBeTruthy();
  });

  it("does not create a launcher when there are no supported target directories", async () => {
    const f = await fixture();
    roots.push(f.root);
    let launcherCalls = 0;
    await expect(installBrowserHost({
      extensionId,
      hostPath: f.hostPath,
      os: "unsupported",
      home: f.root,
      dataHome: f.dataHome,
      writeLauncher: async () => {
        launcherCalls += 1;
        return join(f.root, "launcher");
      },
    })).rejects.toThrow("No supported browser native-host directories");
    expect(launcherCalls).toBe(0);
  });

  it("uninstalls manifests, launcher, and the install record", async () => {
    const f = await fixture();
    roots.push(f.root);
    const options = { browser: "all" as const, extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost(options);
    await uninstallBrowserHost({ manifestDirectories: f.directories, dataHome: f.dataHome });
    for (const { directory } of f.directories) await expect(access(join(directory, "com.zmerchant.agenthands.json"))).rejects.toThrow();
    await expect(access(join(f.root, "launcher"))).rejects.toThrow();
    await expect(access(join(f.dataHome, "agent-hands", "browser-host-install.json"))).rejects.toThrow();
  });

  it("accumulates extension IDs and targets across separate browser installs", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    const record = await readBrowserHostRecord({ dataHome: f.dataHome });
    expect(record?.extensionIds).toEqual([extensionId, secondExtensionId]);
    expect(record?.installedTargets.map(({ manifestPath }) => manifestPath).sort()).toEqual([
      join(f.root, "brave", "com.zmerchant.agenthands.json"),
      join(f.root, "chrome", "com.zmerchant.agenthands.json"),
    ]);
  });

  it("reports a deleted installed manifest while ignoring a browser never installed", async () => {
    const f = await fixture();
    roots.push(f.root);
    await installBrowserHost({ browser: "chrome", extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher });
    await rm(join(f.root, "chrome", "com.zmerchant.agenthands.json"));
    const status = await browserHostStatus({ manifestDirectories: f.directories, dataHome: f.dataHome });
    expect(status.healthy).toBe(false);
    expect(status.lines.join("\n")).toContain("PROBLEM chrome: manifest missing");
    expect(status.lines.join("\n")).toContain("PASS brave: manifest not installed");
  });

  it("preserves the shared launcher and record until the final browser uninstall", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    const remaining = await readBrowserHostRecord({ dataHome: f.dataHome });
    const braveManifest = JSON.parse(await readFile(join(f.root, "brave", "com.zmerchant.agenthands.json"), "utf8"));
    await expect(access(join(f.root, "launcher"))).resolves.toBeUndefined();
    expect(braveManifest.path).toBe(remaining?.launcherPath);
    expect(remaining?.extensionIds).toEqual([secondExtensionId]);
    expect(remaining?.installedTargets).toEqual([{ browser: "brave", manifestPath: join(f.root, "brave", "com.zmerchant.agenthands.json") }]);
    await uninstallBrowserHost({ manifestDirectories: f.directories, dataHome: f.dataHome });
    await expect(access(join(f.root, "brave", "com.zmerchant.agenthands.json"))).rejects.toThrow();
    await expect(access(join(f.root, "launcher"))).rejects.toThrow();
    await expect(readBrowserHostRecord({ dataHome: f.dataHome })).resolves.toBeNull();
  });

  it("uses live manifests when uninstalling from a legacy record", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await removeInstalledTargets(f.dataHome);
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    const remaining = await readBrowserHostRecord({ dataHome: f.dataHome });
    await expect(access(join(f.root, "brave", "com.zmerchant.agenthands.json"))).resolves.toBeUndefined();
    await expect(access(join(f.root, "launcher"))).resolves.toBeUndefined();
    expect(remaining?.installedTargets).toEqual([{ browser: "brave", manifestPath: join(f.root, "brave", "com.zmerchant.agenthands.json") }]);
    expect(remaining?.extensionIds).toEqual([secondExtensionId]);
  });

  it("drops a manifest deleted outside the installer before recording a later install", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await rm(join(f.root, "brave", "com.zmerchant.agenthands.json"));
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    const record = await readBrowserHostRecord({ dataHome: f.dataHome });
    expect(record?.installedTargets).toEqual([{ browser: "chrome", manifestPath: join(f.root, "chrome", "com.zmerchant.agenthands.json") }]);
    expect(record?.extensionIds).toEqual([extensionId]);
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    await expect(access(join(f.root, "launcher"))).rejects.toThrow();
    await expect(readBrowserHostRecord({ dataHome: f.dataHome })).resolves.toBeNull();
  });

  it("reports a legacy record as invalid while preserving its live manifest", async () => {
    const f = await fixture();
    roots.push(f.root);
    await installBrowserHost({ browser: "chrome", extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher });
    await removeInstalledTargets(f.dataHome);
    const status = await browserHostStatus({ manifestDirectories: f.directories, dataHome: f.dataHome });
    expect(status.healthy).toBe(false);
    expect(status.lines.join("\n")).toContain("PASS chrome: manifest present");
    expect(status.lines.join("\n")).toContain("PROBLEM install record missing");
  });

  it("preserves and rebuilds shared state after a deleted record partial uninstall", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await removeInstallRecord(f.dataHome);
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    await expect(access(join(f.root, "brave", "com.zmerchant.agenthands.json"))).resolves.toBeUndefined();
    await expect(access(join(f.root, "launcher"))).resolves.toBeUndefined();
    expect((await readBrowserHostRecord({ dataHome: f.dataHome }))?.installedTargets).toEqual([
      { browser: "brave", manifestPath: join(f.root, "brave", "com.zmerchant.agenthands.json") },
    ]);
    await uninstallBrowserHost({ manifestDirectories: f.directories, dataHome: f.dataHome });
    await expect(access(join(f.root, "launcher"))).rejects.toThrow();
    await expect(readBrowserHostRecord({ dataHome: f.dataHome })).resolves.toBeNull();
  });

  it("preserves and rebuilds shared state after a corrupt record partial uninstall", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await corruptInstallRecord(f.dataHome);
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    await expect(access(join(f.root, "brave", "com.zmerchant.agenthands.json"))).resolves.toBeUndefined();
    await expect(access(join(f.root, "launcher"))).resolves.toBeUndefined();
    expect((await readBrowserHostRecord({ dataHome: f.dataHome }))?.installedTargets).toEqual([
      { browser: "brave", manifestPath: join(f.root, "brave", "com.zmerchant.agenthands.json") },
    ]);
  });

  it("writes one manifest and one record target for duplicate directories", async () => {
    const f = await fixture();
    roots.push(f.root);
    const sharedDirectory = join(f.root, "shared");
    const duplicateDirectories: NativeMessagingHostDirectory[] = [
      { browser: "chrome", directory: sharedDirectory },
      { browser: "brave", directory: sharedDirectory },
    ];
    const lines = await installBrowserHost({ browser: "all", extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: duplicateDirectories, dataHome: f.dataHome, writeLauncher: f.writeLauncher });
    expect(lines.filter((line) => line.startsWith("WROTE "))).toHaveLength(1);
    expect((await readBrowserHostRecord({ dataHome: f.dataHome }))?.installedTargets).toHaveLength(1);
  });

  it("removes the real launcher after an all-browser uninstall with a schema-corrupt record", async () => {
    const f = await fixture();
    roots.push(f.root);
    await installBrowserHost({ browser: "all", extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher });
    await updateInstallRecord(f.dataHome, (record) => { record.launcherPath = {}; });
    await expect(uninstallBrowserHost({ manifestDirectories: f.directories, dataHome: f.dataHome })).resolves.toBeTruthy();
    await expect(access(join(f.root, "launcher"))).rejects.toThrow();
    await expect(readBrowserHostRecord({ dataHome: f.dataHome })).resolves.toBeNull();
  });

  it("rebuilds a stale readable record from the remaining live manifest", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await updateInstallRecord(f.dataHome, (record) => { record.launcherPath = join(f.root, "missing-launcher"); });
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    const record = await readBrowserHostRecord({ dataHome: f.dataHome });
    expect(record?.launcherPath).toBe(join(f.root, "launcher"));
    expect((await browserHostStatus({ manifestDirectories: f.directories, dataHome: f.dataHome })).healthy).toBe(true);
  });

  it("recreates the record directory while reconciling a partial uninstall", async () => {
    const f = await fixture();
    roots.push(f.root);
    const base = { hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost({ ...base, browser: "chrome", extensionId });
    await installBrowserHost({ ...base, browser: "brave", extensionId: secondExtensionId });
    await rm(join(f.dataHome, "agent-hands"), { recursive: true, force: true });
    await uninstallBrowserHost({ browser: "chrome", manifestDirectories: f.directories, dataHome: f.dataHome });
    expect((await readBrowserHostRecord({ dataHome: f.dataHome }))?.installedTargets).toEqual([
      { browser: "brave", manifestPath: join(f.root, "brave", "com.zmerchant.agenthands.json") },
    ]);
  });

  it("reports dead launcher dependencies and version drift", async () => {
    const f = await fixture();
    roots.push(f.root);
    const options = { extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher, version: "0.3.0" };
    await installBrowserHost(options);
    await rm(f.hostPath);
    await rm(f.nodePath);
    const status = await browserHostStatus({ manifestDirectories: f.directories, dataHome: f.dataHome, version: "0.4.0" });
    expect(status.healthy).toBe(false);
    expect(status.lines.join("\n")).toContain("node missing");
    expect(status.lines.join("\n")).toContain("host missing");
    expect(status.lines.join("\n")).toContain("installed 0.3.0, running 0.4.0");
  });

  it("uses the same macOS and Linux directories as native manifest discovery", () => {
    const mac = nativeMessagingHostDirectoriesFor("darwin", "/home/test", "/config");
    const linux = nativeMessagingHostDirectoriesFor("linux", "/home/test", "/config");
    expect(mac).toEqual([
      "/home/test/Library/Application Support/Google/Chrome/NativeMessagingHosts",
      "/home/test/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts",
      "/home/test/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts",
      "/home/test/Library/Application Support/Chromium/NativeMessagingHosts",
      "/home/test/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
      "/home/test/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ]);
    expect(linux).toEqual([
      "/config/google-chrome/NativeMessagingHosts",
      "/config/google-chrome-beta/NativeMessagingHosts",
      "/config/chromium/NativeMessagingHosts",
      "/config/microsoft-edge/NativeMessagingHosts",
      "/config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ]);
    expect(browserHostDirectoriesFor("darwin", "/home/test", "/config", "all").map(({ directory }) => directory)).toEqual(mac);
    expect(browserHostDirectoriesFor("linux", "/home/test", "/config", "all").map(({ directory }) => directory)).toEqual(linux);
  });
});
