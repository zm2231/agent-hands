// CDP endpoint discovery: attach to a running Chrome-family browser.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir, platform } from "node:os";

const CDP_HOST = process.env.CDP_HOST ?? "127.0.0.1";
const CDP_PORT = parseInt(process.env.CDP_PORT ?? "9222", 10);
const PROBE_TIMEOUT = 2000;

interface VersionInfo {
  webSocketDebuggerUrl: string;
  [key: string]: unknown;
}

async function probeHttp(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = (await resp.json()) as VersionInfo;
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

function devToolsPortFileCandidates(): string[] {
  const candidates: string[] = [];

  if (process.env.CDP_PORT_FILE) {
    candidates.push(process.env.CDP_PORT_FILE);
  }

  const os = platform();
  let browsers: string[] = [];

  if (os === "darwin") {
    const appSupport = join(homedir(), "Library", "Application Support");
    browsers = [
      "Google/Chrome",
      "Google/Chrome Beta",
      "Google/Chrome for Testing",
      "Chromium",
      "BraveSoftware/Brave-Browser",
      "Microsoft Edge",
    ];
    for (const b of browsers) {
      candidates.push(join(appSupport, b, "DevToolsActivePort"));
      candidates.push(join(appSupport, b, "Default", "DevToolsActivePort"));
    }
  } else if (os === "linux") {
    const config = join(homedir(), ".config");
    browsers = [
      "google-chrome",
      "google-chrome-beta",
      "chromium",
      "vivaldi",
      "vivaldi-snapshot",
      "BraveSoftware/Brave-Browser",
      "microsoft-edge",
    ];
    for (const b of browsers) {
      candidates.push(join(config, b, "DevToolsActivePort"));
      candidates.push(join(config, b, "Default", "DevToolsActivePort"));
    }
    // Flatpak paths.
    const flatpakApps: Record<string, string> = {
      "com.google.Chrome": "google-chrome",
      "org.chromium.Chromium": "chromium",
      "com.brave.Browser": "BraveSoftware/Brave-Browser",
      "com.microsoft.Edge": "microsoft-edge",
      "com.vivaldi.Vivaldi": "vivaldi",
    };
    for (const [appId, b] of Object.entries(flatpakApps)) {
      const base = join(homedir(), ".var", "app", appId, "config", b);
      candidates.push(join(base, "DevToolsActivePort"));
      candidates.push(join(base, "Default", "DevToolsActivePort"));
    }
  } else if (os === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    browsers = [
      "Google/Chrome",
      "BraveSoftware/Brave-Browser",
      "Microsoft/Edge",
    ];
    for (const b of browsers) {
      candidates.push(join(localAppData, b, "User Data", "DevToolsActivePort"));
      candidates.push(join(localAppData, b, "User Data", "Default", "DevToolsActivePort"));
    }
  }

  return candidates;
}

async function probePortFile(): Promise<string | null> {
  for (const candidate of devToolsPortFileCandidates()) {
    try {
      const content = await readFile(candidate, "utf-8");
      const lines = content.trim().split("\n");
      if (lines.length >= 2) {
        const port = lines[0].trim();
        const path = lines[1].trim();
        return `ws://${CDP_HOST}:${port}${path}`;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function discoverEndpoint(): Promise<string> {
  // Try HTTP probe first.
  const httpUrl = await probeHttp();
  if (httpUrl) return httpUrl;

  // Try DevToolsActivePort file.
  const fileUrl = await probePortFile();
  if (fileUrl) return fileUrl;

  throw new Error(
    "No Chrome-family browser found with remote debugging enabled. " +
      "Start Chrome with --remote-debugging-port=9222, or set CDP_PORT/CDP_PORT_FILE."
  );
}
