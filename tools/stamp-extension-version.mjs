import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const manifestUrl = new URL("../extension/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

if (manifest.version !== packageJson.version) {
  manifest.version = packageJson.version;
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
}
