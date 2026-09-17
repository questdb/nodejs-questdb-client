// Guards a two-package release dispatched from one commit.
//
// JS-DevTools/npm-publish skips a version that is already on npm, which was
// harmless while this repo published one package: a forgotten bump made the
// whole workflow a no-op. With two packages a version that only one of them
// has already published publishes the other and still reports success, leaving
// the two halves of one release on different versions. This turns that into a
// failure before either publish step runs.
//
// The distinction that matters is *which* half is missing. A version no package
// has published is a normal release. A version every package has published is a
// forgotten bump, and refusing it is the point of this script. A version only
// some packages have published is resumable only when npm says the published
// artifact came from this exact release commit. Then it is the wreckage of a
// dispatch whose first publish step succeeded and whose second failed, and the
// publish action's skip-if-present behaviour makes re-dispatching it exactly
// the right repair. A different or missing gitHead is an older unrelated
// artifact that must never authorize publishing new code under the same
// version.
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

function publishedGitHead(name, version) {
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["view", `${name}@${version}`, "gitHead", "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!output) return undefined;
  const parsed = JSON.parse(output);
  return typeof parsed === "string" ? parsed : undefined;
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

const published = [];
const pending = [];
for (const release of releases) {
  const onRegistry = publishedVersions(release.name);
  const list = Array.isArray(onRegistry) ? onRegistry : [onRegistry];
  (list.includes(release.version) ? published : pending).push(release);
}
const label = ({ name, version }) => `${name}@${version}`;

if (pending.length === 0) {
  problems.push(
    `every package has already published this version (${published.map(label).join(", ")}), ` +
      `so this dispatch would publish nothing. Bump the version first.`,
  );
}

if (published.length > 0 && pending.length > 0) {
  const releaseCommit = (
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
  ).trim();
  for (const release of published) {
    const gitHead = publishedGitHead(release.name, release.version);
    if (gitHead !== releaseCommit) {
      problems.push(
        `${label(release)} was published from gitHead ${gitHead ?? "<missing>"}, ` +
          `not this release commit ${releaseCommit}; this is an older unrelated artifact, ` +
          `not a partial release that can be resumed. Bump the version first.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`refusing to publish:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

if (published.length > 0) {
  // Resuming a partial release. Say so loudly: the run is legitimate, but an
  // earlier dispatch failed midway and that is worth seeing in the log.
  console.warn(
    `resuming a partial release: ${published.map(label).join(", ")} already on npm, ` +
      `publishing ${pending.map(label).join(", ")}. The published package(s) will be skipped.`,
  );
}

console.log(
  `release check passed: ${releases
    .map((release) => `${release.name}@${release.version}`)
    .join(", ")}`,
);
