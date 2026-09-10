import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = process.argv[2];
const publicPackages = new Set(["nodejs-client", "browser-client"]);
if (!packageName || !publicPackages.has(packageName)) {
  throw new Error(`unknown public package: ${packageName ?? "<missing>"}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(root, "packages", packageName, "dist"), {
  recursive: true,
  force: true,
});
