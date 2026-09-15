import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  nativeMessagingHostDirectories,
  nativeMessagingHostDirectoryEntriesFor,
  type NativeMessagingBrowser,
  type NativeMessagingHostDirectory,
} from "./cdp/manifest.js";
import { runningVersion } from "../version.js";

const execFileAsync = promisify(execFile);
const HOST_FILE_NAME = "com.zmerchant.agenthands.json";
const RECORD_FILE_NAME = "browser-host-install.json";
const STABLE_INSTALL_MESSAGE = "The browser extension host needs a stable install. Run `npm i -g @zmerchant/agent-hands` or use a source checkout, then re-run install-browser-host.";
let versionWarningShown = false;

export type BrowserSelection = NativeMessagingBrowser | "all";

export type BrowserHostRecord = {
  version: string;
  nodePath: string;
  hostPath: string;
  launcherPath: string;
  extensionIds: string[];
  installedAt: string;
};

type Manifest = {
  allowed_origins?: unknown;
};

export type InstallerOptions = {
  browser?: BrowserSelection;
  extensionId?: string;
  hostPath?: string;
  os?: string;
  home?: string;
  configHome?: string;
  dataHome?: string;
  manifestDirectories?: NativeMessagingHostDirectory[];
  nodePath?: string;
  version?: string;
  npmRoot?: () => Promise<string>;
  npmCache?: () => Promise<string>;
  writeLauncher?: (hostPath: string, nodePath: string) => Promise<string>;
};

export type BrowserHostStatus = {
  lines: string[];
  healthy: boolean;
};

function pathIsWithin(path: string, parent: string): boolean {
  const difference = relative(resolve(parent), resolve(path));
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function npmValue(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npm", args);
  return stdout.trim();
}

function defaultDataHome(os: string, home: string): string {
  if (os === "darwin") return join(home, "Library", "Application Support");
  return process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
}

function recordPath(dataHome: string): string {
  return join(dataHome, "agent-hands", RECORD_FILE_NAME);
}

export function browserHostDirectoriesFor(
  os: string,
  home: string,
  configHome: string,
  browser: BrowserSelection = "chrome",
): NativeMessagingHostDirectory[] {
  const entries = nativeMessagingHostDirectoryEntriesFor(os, home, configHome);
  return browser === "all" ? entries : entries.filter((entry) => entry.browser === browser);
}

function requestedDirectories(options: InstallerOptions): NativeMessagingHostDirectory[] {
  const selected = options.browser ?? "chrome";
  const override = process.env.AGENT_HANDS_NATIVE_HOST_MANIFEST_DIRS;
  if (override && !options.manifestDirectories) {
    return nativeMessagingHostDirectories().map((directory) => ({ browser: "chrome", directory }));
  }
  const os = options.os ?? platform();
  const home = options.home ?? homedir();
  const configHome = options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return options.manifestDirectories
    ? selected === "all" ? options.manifestDirectories : options.manifestDirectories.filter((entry) => entry.browser === selected)
    : browserHostDirectoriesFor(os, home, configHome, selected);
}

export function validateExtensionId(extensionId: string): void {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("Invalid extension ID. Copy the 32-character ID from chrome://extensions with Developer mode enabled.");
  }
}

function defaultHostPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../host/native-host.mjs");
}

async function sourceCheckout(hostPath: string): Promise<boolean> {
  const root = dirname(dirname(hostPath));
  return exists(join(root, ".git"));
}

async function resolveStableHostPath(options: InstallerOptions): Promise<string> {
  const hostPath = resolve(options.hostPath ?? process.env.AGENT_HANDS_HOST_PATH ?? defaultHostPath());
  if (!isAbsolute(hostPath) || !await exists(hostPath)) throw new Error(`Native host script not found: ${hostPath}`);
  const segments = hostPath.split(sep);
  const npmCache = await (options.npmCache ?? (() => npmValue(["config", "get", "cache"])))().catch(() => "");
  if (segments.includes("_npx") || (npmCache && pathIsWithin(hostPath, npmCache))) throw new Error(STABLE_INSTALL_MESSAGE);
  const npmRoot = await (options.npmRoot ?? (() => npmValue(["root", "-g"])))().catch(() => "");
  if ((npmRoot && pathIsWithin(hostPath, npmRoot)) || await sourceCheckout(hostPath)) return hostPath;
  throw new Error(STABLE_INSTALL_MESSAGE);
}

async function loadManifest(path: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

function extensionIds(manifest: Manifest): string[] {
  if (!Array.isArray(manifest.allowed_origins)) return [];
  return manifest.allowed_origins
    .filter((origin): origin is string => typeof origin === "string")
    .map((origin) => /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1])
    .filter((id): id is string => Boolean(id));
}

function manifestJson(launcherPath: string, ids: string[]): Record<string, unknown> {
  return {
    name: "com.zmerchant.agenthands",
    description: "agent-hands browser native host",
    path: launcherPath,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
}

async function defaultWriteLauncher(hostPath: string, nodePath: string): Promise<string> {
  const launcher = await hostManifestModule();
  return launcher.writeLauncher(hostPath, nodePath);
}

async function defaultLauncherPath(): Promise<string> {
  const launcher = await hostManifestModule();
  return launcher.launcherPath();
}

async function hostManifestModule(): Promise<{
  launcherPath(): string;
  writeLauncher(hostScript: string, nodePath: string): Promise<string>;
}> {
  return await import(new URL("../../host/manifest.mjs", import.meta.url).href) as {
    launcherPath(): string;
    writeLauncher(hostScript: string, nodePath: string): Promise<string>;
  };
}

export async function readBrowserHostRecord(options: Pick<InstallerOptions, "os" | "home" | "dataHome"> = {}): Promise<BrowserHostRecord | null> {
  const os = options.os ?? platform();
  const home = options.home ?? homedir();
  const path = recordPath(options.dataHome ?? defaultDataHome(os, home));
  try {
    return JSON.parse(await readFile(path, "utf8")) as BrowserHostRecord;
  } catch {
    return null;
  }
}

export async function installBrowserHost(options: InstallerOptions): Promise<string[]> {
  if (!options.extensionId) throw new Error("Usage: agent-hands install-browser-host <extension-id> [--browser chrome,brave,edge,chromium|all]");
  validateExtensionId(options.extensionId);
  const hostPath = await resolveStableHostPath(options);
  const nodePath = options.nodePath ?? process.execPath;
  const directories = requestedDirectories(options);
  if (directories.length === 0) throw new Error("No supported browser native-host directories were found.");
  const launcherPath = await (options.writeLauncher ?? defaultWriteLauncher)(hostPath, nodePath);
  const allIds = new Set<string>([options.extensionId]);
  const lines: string[] = [];
  for (const { browser, directory } of directories) {
    const manifestPath = join(directory, HOST_FILE_NAME);
    const ids = new Set([...extensionIds(await loadManifest(manifestPath)), options.extensionId]);
    for (const id of ids) allIds.add(id);
    await mkdir(directory, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifestJson(launcherPath, [...ids].sort()), null, 2)}\n`, "utf8");
    lines.push(`WROTE ${browser}: ${manifestPath}`);
  }
  const os = options.os ?? platform();
  const home = options.home ?? homedir();
  const dataHome = options.dataHome ?? defaultDataHome(os, home);
  const record: BrowserHostRecord = {
    version: options.version ?? runningVersion(),
    nodePath,
    hostPath,
    launcherPath,
    extensionIds: [...allIds].sort(),
    installedAt: new Date().toISOString(),
  };
  await mkdir(dirname(recordPath(dataHome)), { recursive: true });
  await writeFile(recordPath(dataHome), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return [...lines, "reload the extension and restart the browser"];
}

export async function uninstallBrowserHost(options: InstallerOptions = {}): Promise<string[]> {
  const effectiveOptions = options.browser ? options : { ...options, browser: "all" as const };
  const directories = requestedDirectories(effectiveOptions);
  const lines: string[] = [];
  for (const { browser, directory } of directories) {
    const manifestPath = join(directory, HOST_FILE_NAME);
    await rm(manifestPath, { force: true });
    lines.push(`REMOVED ${browser}: ${manifestPath}`);
  }
  const record = await readBrowserHostRecord(options);
  await rm(record?.launcherPath ?? await defaultLauncherPath(), { force: true });
  const os = options.os ?? platform();
  const home = options.home ?? homedir();
  await rm(recordPath(options.dataHome ?? defaultDataHome(os, home)), { force: true });
  return lines;
}

export async function browserHostStatus(options: InstallerOptions = {}): Promise<BrowserHostStatus> {
  const lines: string[] = [];
  let healthy = true;
  const record = await readBrowserHostRecord(options);
  for (const { browser, directory } of requestedDirectories({ ...options, browser: "all" })) {
    const manifestPath = join(directory, HOST_FILE_NAME);
    const manifestExists = await exists(manifestPath);
    if (manifestExists) lines.push(`PASS ${browser}: manifest present at ${manifestPath}`);
    else lines.push(`PASS ${browser}: manifest not installed at ${manifestPath}`);
  }
  if (!record) {
    healthy = false;
    lines.push("PROBLEM install record missing. Run install-browser-host.");
    return { lines, healthy };
  }
  if (await exists(record.launcherPath)) lines.push(`PASS launcher: ${record.launcherPath}`);
  else {
    healthy = false;
    lines.push(`PROBLEM launcher missing: ${record.launcherPath}. Run install-browser-host.`);
  }
  if (await exists(record.nodePath)) lines.push(`PASS node: ${record.nodePath}`);
  else {
    healthy = false;
    lines.push(`PROBLEM node missing: ${record.nodePath}. Re-run install-browser-host after changing Node.`);
  }
  if (await exists(record.hostPath)) lines.push(`PASS host: ${record.hostPath}`);
  else {
    healthy = false;
    lines.push(`PROBLEM host missing: ${record.hostPath}. Run install-browser-host.`);
  }
  const version = options.version ?? runningVersion();
  if (record.version === version) lines.push(`PASS version: ${record.version}`);
  else {
    healthy = false;
    lines.push(`PROBLEM version: installed ${record.version}, running ${version}. Run install-browser-host.`);
  }
  lines.push(`PASS extension IDs: ${record.extensionIds.join(", ") || "none"}`);
  return { lines, healthy };
}

export async function warnIfBrowserHostVersionDrift(): Promise<void> {
  if (versionWarningShown) return;
  const record = await readBrowserHostRecord();
  if (record && record.version !== runningVersion()) {
    versionWarningShown = true;
    console.warn(`agent-hands browser host was installed for ${record.version}; running ${runningVersion()}. Re-run install-browser-host.`);
  }
}

export { STABLE_INSTALL_MESSAGE, recordPath };
