import { readFileSync } from "node:fs";

export function runningVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  if (!packageJson.version) throw new Error("package.json has no version.");
  return packageJson.version;
}
