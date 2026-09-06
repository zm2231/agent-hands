// Verify the signed OpenAI components required for desktop control.

import { execFile } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const EXPECTED_TEAM_ID = "2DC432GLL2";
const CODESIGN_TIMEOUT = 10_000;

function clientPaths(): { current: string; legacy: string } {
  const tail =
    "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
  return {
    current: join(homedir(), ".codex", "computer-use", tail),
    legacy: join(
      "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use",
      tail
    ),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function verifySignature(bin: string): Promise<void> {
  // Strict verify.
  await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", bin], {
    timeout: CODESIGN_TIMEOUT,
  });

  // Team ID check.
  const { stdout } = await execFileAsync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=2", bin],
    { timeout: CODESIGN_TIMEOUT }
  );
  // codesign -dv writes to stderr, but promisify captures both.
  // Actually codesign -dv output goes to stderr. Let's capture stderr.
  // Re-run capturing stderr.
  const result = await new Promise<string>((resolve, reject) => {
    const proc = require("node:child_process").execFile(
      "/usr/bin/codesign",
      ["-dv", "--verbose=2", bin],
      { timeout: CODESIGN_TIMEOUT },
      (err: Error | null, _stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve(stderr);
      }
    );
  });

  if (!result.includes(`TeamIdentifier=${EXPECTED_TEAM_ID}`)) {
    throw new Error(
      `Signature team ID mismatch for ${bin}: expected ${EXPECTED_TEAM_ID}`
    );
  }
}

export interface BrokerComponents {
  codexPath: string;
  clientPath: string;
  codexVersion: string;
  clientBuild: string;
}

export async function verifyBrokerComponents(): Promise<BrokerComponents> {
  // Verify codex app-server exists.
  if (!(await exists(CODEX_PATH))) {
    throw new Error("ChatGPT app not found at /Applications/ChatGPT.app");
  }

  // Find the Computer Use client.
  const paths = clientPaths();
  let clientPath: string;
  if (await exists(paths.current)) {
    clientPath = paths.current;
  } else if (await exists(paths.legacy)) {
    clientPath = paths.legacy;
  } else {
    throw new Error(
      "Computer Use component not found. Enable Computer Use in the ChatGPT app."
    );
  }

  // Verify signatures.
  await verifySignature(CODEX_PATH);
  await verifySignature(clientPath);

  // Read codex version.
  let codexVersion = "unknown";
  try {
    const { stdout } = await execFileAsync(CODEX_PATH, ["--version"], {
      timeout: 5000,
    });
    const match = stdout.match(/^codex-cli\s+(\d+\.\S+)/);
    if (match) codexVersion = match[1];
  } catch {
    // Non-fatal for version; signature already verified.
  }

  // Read client build from Info.plist.
  let clientBuild = "unknown";
  try {
    const plistPath = clientPath.replace(
      /\/Contents\/MacOS\/SkyComputerUseClient$/,
      "/Contents/Info.plist"
    );
    const { stdout } = await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleVersion",
      "raw",
      plistPath,
    ]);
    clientBuild = stdout.trim();
  } catch {
    // Non-fatal.
  }

  return { codexPath: CODEX_PATH, clientPath, codexVersion, clientBuild };
}
