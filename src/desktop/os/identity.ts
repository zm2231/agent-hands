// App identity resolution for macOS.

import { execFile } from "node:child_process";
import { realpath, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export interface AppIdentity {
  bundleId: string | null;
  leaseId: string;
}

async function bundleIdFromPath(appPath: string): Promise<AppIdentity> {
  try {
    const resolved = await realpath(appPath);
    const plistPath = `${resolved}/Contents/Info.plist`;
    const { stdout } = await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      plistPath,
    ]);
    const bid = stdout.trim();
    if (BUNDLE_ID_RE.test(bid)) {
      return { bundleId: bid, leaseId: bid.toLowerCase() };
    }
    return { bundleId: null, leaseId: `path:${resolved.toLowerCase()}` };
  } catch {
    return { bundleId: null, leaseId: `path:${appPath.toLowerCase()}` };
  }
}

function escapeAppleScript(s: string): string {
  // Reject control chars and backslashes; escape quotes.
  if (/[\x00-\x1f\\]/.test(s)) {
    throw new Error(`Unsafe characters in app identifier: ${s.slice(0, 60)}`);
  }
  return s.replace(/"/g, '\\"');
}

async function bundleIdFromIdentifier(identifier: string): Promise<AppIdentity> {
  try {
    const safe = escapeAppleScript(identifier);
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      `id of application id "${safe}"`,
    ]);
    const bid = stdout.trim();
    if (BUNDLE_ID_RE.test(bid)) {
      return { bundleId: bid, leaseId: bid.toLowerCase() };
    }
  } catch {
    // Fall through.
  }
  return { bundleId: null, leaseId: identifier.toLowerCase() };
}

async function bundleIdFromName(name: string): Promise<AppIdentity> {
  try {
    const safe = escapeAppleScript(name);
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      `id of application "${safe}"`,
    ]);
    const bid = stdout.trim();
    if (BUNDLE_ID_RE.test(bid)) {
      return { bundleId: bid, leaseId: bid.toLowerCase() };
    }
  } catch {
    // Fall through.
  }
  return { bundleId: null, leaseId: `name:${name.toLowerCase()}` };
}

export async function resolveAppIdentity(
  app: string
): Promise<AppIdentity> {
  if (app.startsWith("/")) {
    return bundleIdFromPath(app);
  }
  if (BUNDLE_ID_RE.test(app)) {
    return bundleIdFromIdentifier(app);
  }
  return bundleIdFromName(app);
}

/** Get the frontmost app bundle id. */
export async function getFrontmostBundleId(): Promise<string | null> {
  try {
    const { stdout: asnOut } = await execFileAsync("/usr/bin/lsappinfo", [
      "front",
    ]);
    const asn = asnOut.trim();
    if (!asn) return null;

    const { stdout: infoOut } = await execFileAsync("/usr/bin/lsappinfo", [
      "info",
      "-only",
      "bundleID",
      asn,
    ]);
    // Parse either "CFBundleIdentifier"="X" or bundleID="X"
    const match = infoOut.match(
      /(?:"CFBundleIdentifier"|bundleID)="([^"]+)"/
    );
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
