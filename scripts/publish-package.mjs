// Publishes one package directory to npm, unless npm already has its version.
//
// The publish workflow runs this for each selected package once
// check-release-versions.mjs has passed, which leaves a version npm already
// has only as the published half of a partial release being resumed.
//
// Any `npm view` failure counts as "not on npm". E404 is the normal answer for
// a new version; after any other failure, `npm publish` itself refuses a
// version npm already has. A wrong answer therefore fails the step instead of
// skipping a package that was never published.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const packageDirectory = process.argv[2];
if (!packageDirectory) {
  console.error("usage: node scripts/publish-package.mjs <package directory>");
  process.exit(1);
}

const { name, version } = JSON.parse(
  readFileSync(join(packageDirectory, "package.json"), "utf8"),
);

const view = spawnSync(npm, ["view", `${name}@${version}`, "version"], {
  cwd: packageDirectory,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
if (view.stdout?.trim() === version) {
  console.log(`${name}@${version} is already on npm; skipping it.`);
  process.exit(0);
}

const publish = spawnSync(
  npm,
  ["publish", "--access", "public", "--provenance", "--ignore-scripts"],
  { cwd: packageDirectory, stdio: "inherit" },
);
if (publish.error) {
  console.error(`npm publish failed: ${publish.error.message}`);
}
process.exit(publish.status ?? 1);
