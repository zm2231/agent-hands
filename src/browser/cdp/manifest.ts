import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const HOST_NAME = "com.zmerchant.agenthands.json";

export type NativeMessagingBrowser = "chrome" | "chromium" | "edge" | "brave";

export type NativeMessagingHostDirectory = {
  browser: NativeMessagingBrowser;
  directory: string;
};

export function nativeMessagingHostDirectoryEntriesFor(
  os: string,
  home: string,
  configHome: string,
): NativeMessagingHostDirectory[] {
  if (os === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      { browser: "chrome", directory: join(support, "Google", "Chrome", "NativeMessagingHosts") },
      { browser: "chrome", directory: join(support, "Google", "Chrome Beta", "NativeMessagingHosts") },
      { browser: "chrome", directory: join(support, "Google", "Chrome Canary", "NativeMessagingHosts") },
      { browser: "chromium", directory: join(support, "Chromium", "NativeMessagingHosts") },
      { browser: "edge", directory: join(support, "Microsoft Edge", "NativeMessagingHosts") },
      { browser: "brave", directory: join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts") },
    ];
  }
  if (os === "linux") {
    return [
      { browser: "chrome", directory: join(configHome, "google-chrome", "NativeMessagingHosts") },
      { browser: "chrome", directory: join(configHome, "google-chrome-beta", "NativeMessagingHosts") },
      { browser: "chromium", directory: join(configHome, "chromium", "NativeMessagingHosts") },
      { browser: "edge", directory: join(configHome, "microsoft-edge", "NativeMessagingHosts") },
      { browser: "brave", directory: join(configHome, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts") },
    ];
  }
  return [];
}

export function nativeMessagingHostDirectoriesFor(
  os: string,
  home: string,
  configHome: string,
): string[] {
  return nativeMessagingHostDirectoryEntriesFor(os, home, configHome).map(({ directory }) => directory);
}

export function nativeMessagingHostDirectories(): string[] {
  const override = process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;
  if (override) return override.split(delimiter).filter(Boolean);
  const home = homedir();
  return nativeMessagingHostDirectoriesFor(platform(), home, process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
}

export async function hasNativeMessagingHostManifest(): Promise<boolean> {
  return hasNativeMessagingHostManifestIn(nativeMessagingHostDirectories());
}

export async function hasNativeMessagingHostManifestIn(directories: string[]): Promise<boolean> {
  for (const directory of directories) {
    try {
      await access(join(directory, HOST_NAME));
      return true;
    } catch {}
  }
  return false;
}
