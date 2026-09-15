import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const HOST_NAME = "com.zmerchant.agenthands.json";

export function nativeMessagingHostDirectoriesFor(
  os: string,
  home: string,
  configHome: string,
): string[] {
  if (os === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      join(support, "Google", "Chrome", "NativeMessagingHosts"),
      join(support, "Google", "Chrome Beta", "NativeMessagingHosts"),
      join(support, "Google", "Chrome Canary", "NativeMessagingHosts"),
      join(support, "Chromium", "NativeMessagingHosts"),
      join(support, "Microsoft Edge", "NativeMessagingHosts"),
      join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    ];
  }
  if (os === "linux") {
    return [
      join(configHome, "google-chrome", "NativeMessagingHosts"),
      join(configHome, "google-chrome-beta", "NativeMessagingHosts"),
      join(configHome, "chromium", "NativeMessagingHosts"),
      join(configHome, "microsoft-edge", "NativeMessagingHosts"),
      join(configHome, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    ];
  }
  return [];
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
