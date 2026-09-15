import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STABLE_INSTALL_MESSAGE,
  browserHostDirectoriesFor,
  browserHostStatus,
  installBrowserHost,
  uninstallBrowserHost,
  validateExtensionId,
} from "../src/browser/host-installer.js";
import { nativeMessagingHostDirectoriesFor, type NativeMessagingHostDirectory } from "../src/browser/cdp/manifest.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const secondExtensionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

  it("accepts explicit and environment host-path overrides", async () => {
    const f = await fixture();
    roots.push(f.root);
    process.env.AGENT_HANDS_HOST_PATH = f.hostPath;
    process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS = join(f.root, "override");
    await expect(installBrowserHost({ extensionId, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).resolves.toBeTruthy();
    await expect(access(join(f.root, "override", "com.zmerchant.agenthands.json"))).resolves.toBeUndefined();
    await expect(installBrowserHost({ extensionId, hostPath: f.hostPath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher })).resolves.toBeTruthy();
  });

  it("uninstalls manifests, launcher, and the install record", async () => {
    const f = await fixture();
    roots.push(f.root);
    const options = { browser: "all" as const, extensionId, hostPath: f.hostPath, nodePath: f.nodePath, manifestDirectories: f.directories, dataHome: f.dataHome, writeLauncher: f.writeLauncher };
    await installBrowserHost(options);
    await uninstallBrowserHost({ browser: "all", manifestDirectories: f.directories, dataHome: f.dataHome });
    for (const { directory } of f.directories) await expect(access(join(directory, "com.zmerchant.agenthands.json"))).rejects.toThrow();
    await expect(access(join(f.root, "launcher"))).rejects.toThrow();
    await expect(access(join(f.dataHome, "agent-hands", "browser-host-install.json"))).rejects.toThrow();
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
