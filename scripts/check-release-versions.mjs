// Guards a lockstep-versioned release of one or both packages.
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
// forgotten bump, and refusing it is the point of this script. On a `both`
// dispatch, a version only some packages have published is resumable only
// when npm says the published artifact came from this exact release commit.
// Then it is either the wreckage of a dispatch whose first publish step
// succeeded and whose second failed, or a package deliberately released on its
// own from this commit (see RELEASE_PACKAGES below). Either way the publish
// action's skip-if-present behaviour makes publishing the rest from this commit
// exactly right. A different or missing gitHead is an older unrelated artifact
// that must never authorize publishing new code under the same version.
//
// RELEASE_PACKAGES (the publish workflow's `packages` input) narrows the
// dispatch to one package: `nodejs`, `browser`, or `both` (the default). The
// manifests must still carry the same version, so the repository never drifts
// into per-package versioning, but only the selected packages are checked
// against npm. That lets one package ship first and the other follow later
// under the same version, from a later commit, with its own dispatch.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = {
  nodejs: "packages/nodejs-client",
  browser: "packages/browser-client",
};
const SELECTIONS = {
  both: ["nodejs", "browser"],
  nodejs: ["nodejs"],
  browser: ["browser"],
};

const selectionName = (process.env.RELEASE_PACKAGES ?? "").trim() || "both";
const selection = Object.hasOwn(SELECTIONS, selectionName)
  ? SELECTIONS[selectionName]
  : undefined;
if (!selection) {
  console.error(
    `refusing to publish:\n  unknown RELEASE_PACKAGES value ${JSON.stringify(selectionName)}; ` +
      `expected one of ${Object.keys(SELECTIONS).join(", ")}.`,
  );
  process.exit(1);
}

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
const manifests = Object.entries(PACKAGES).map(([key, directory]) => {
  const { name, version } = manifest(directory);
  return { key, name, version };
});

const versions = new Set(manifests.map((release) => release.version));
if (versions.size > 1) {
  problems.push(
    `the published packages are on different versions: ${manifests
      .map((release) => `${release.name}@${release.version}`)
      .join(", ")}. Keep the manifests in lockstep.`,
  );
}

const releases = manifests.filter((release) => selection.includes(release.key));
const label = ({ name, version }) => `${name}@${version}`;

function isOnRegistry({ name, version }) {
  const onRegistry = publishedVersions(name);
  const list = Array.isArray(onRegistry) ? onRegistry : [onRegistry];
  return list.includes(version);
}

const published = [];
const pending = [];
for (const release of releases) {
  (isOnRegistry(release) ? published : pending).push(release);
}

if (pending.length === 0) {
  if (releases.length === manifests.length) {
    problems.push(
      `every package has already published this version (${published.map(label).join(", ")}), ` +
        `so this dispatch would publish nothing. Bump the version first.`,
    );
  } else {
    // A narrowed dispatch of an already-published package is most likely the
    // follow-up of a single-package release with the wrong package selected.
    // Point at the unselected package still missing from npm, if any.
    const missing = manifests.filter(
      (release) => !selection.includes(release.key) && !isOnRegistry(release),
    );
    problems.push(
      `the selected package has already published this version (${published.map(label).join(", ")}), ` +
        `so this dispatch would publish nothing. ` +
        (missing.length > 0
          ? `${missing.map(label).join(", ")} is not on npm yet; dispatch with ` +
            `packages=${missing.map((release) => release.key).join(",")} to publish it ` +
            `under this version, or bump the version first.`
          : `Bump the version first.`),
    );
  }
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
          `not a partial release that can be resumed. Bump the version first, or, if ` +
          `${release.name} was deliberately released on its own, dispatch with ` +
          `packages=${pending.map((p) => p.key).join(",")} to publish only the rest.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`refusing to publish:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

if (published.length > 0) {
  // Resuming a partial release. Say so loudly: the run is legitimate, but
  // either an earlier dispatch failed midway or a package was released on its
  // own from this commit, and which one is worth checking in the log.
  console.warn(
    `resuming a partial release: ${published.map(label).join(", ")} already on npm ` +
      `from this commit, publishing ${pending.map(label).join(", ")}. Either an earlier ` +
      `dispatch failed midway or the published package(s) were released on their own; ` +
      `they will be skipped.`,
  );
}

console.log(
  `release check passed (packages=${selectionName}): ${releases
    .map((release) => `${release.name}@${release.version}`)
    .join(", ")}`,
);
