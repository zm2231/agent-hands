import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const HOST_NAME = "com.zmerchant.agenthands.json";

export function nativeMessagingHostDirectories(): string[] {
  const override = process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;
  if (override) return override.split(delimiter).filter(Boolean);
  const home = homedir();
  if (platform() === "darwin") {
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
  return [];
}

export async function hasNativeMessagingHostManifest(): Promise<boolean> {
  for (const directory of nativeMessagingHostDirectories()) {
    try {
      await access(join(directory, HOST_NAME));
      return true;
    } catch {}
  }
  return false;
}
