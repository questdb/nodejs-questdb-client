// Guards a two-package release dispatched from one commit.
//
// JS-DevTools/npm-publish skips a version that is already on npm, which was
// harmless while this repo published one package: a forgotten bump made the
// whole workflow a no-op. With two packages a version that only one of them
// has already published publishes the other and still reports success, leaving
// the two halves of one release on different versions. This turns that into a
// failure before either publish step runs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["packages/nodejs-client", "packages/browser-client"];

function manifest(packageDirectory) {
  return JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
}

/** Versions already on npm, or [] for a package that has never been published. */
function publishedVersions(name) {
  try {
    return JSON.parse(
      execFileSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["view", name, "versions", "--json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? "";
    // A package nobody has published yet is the expected state for a new one.
    if (stderr.includes("E404") || stderr.includes("404 Not Found")) return [];
    throw new Error(`npm view ${name} versions failed:\n${stderr.trim()}`);
  }
}

const problems = [];
const releases = PACKAGES.map(manifest).map(({ name, version }) => ({
  name,
  version,
}));

const versions = new Set(releases.map((release) => release.version));
if (versions.size > 1) {
  problems.push(
    `the published packages are on different versions: ${releases
      .map((release) => `${release.name}@${release.version}`)
      .join(", ")}. Release them in lockstep.`,
  );
}

for (const { name, version } of releases) {
  const published = publishedVersions(name);
  if ((Array.isArray(published) ? published : [published]).includes(version)) {
    problems.push(
      `${name}@${version} is already published, so this dispatch would skip it ` +
        `and publish only the other package. Bump the version first.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`refusing to publish:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `release check passed: ${releases
    .map((release) => `${release.name}@${release.version}`)
    .join(", ")}`,
);
