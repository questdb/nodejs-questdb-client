import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The only version the fake registry knows. The tests run the script against
// fixture manifests in a temporary root rather than the repository's own, so
// an ordinary version bump cannot change what they observe.
const PUBLISHED = "5.0.0";

const fakeNpm = `#!/usr/bin/env node
const [, , command, specifier, field] = process.argv;
if (command !== "view") process.exit(2);
if (field === "versions") {
  console.log(specifier === "@questdb/nodejs-client" ? '["${PUBLISHED}"]' : '[]');
} else if (
  specifier === "@questdb/nodejs-client@${PUBLISHED}" &&
  field === "gitHead"
) {
  console.log(JSON.stringify(process.env.FAKE_NPM_GIT_HEAD));
} else {
  process.exit(2);
}
`;

const script = join(process.cwd(), "scripts", "check-release-versions.mjs");

describe.skipIf(process.platform === "win32")("release version gate", () => {
  let scratch: string;
  let bin: string;
  let root: string;

  /** A repository root holding only the two published manifests. */
  async function manifestRoot(
    name: string,
    versions: { nodejs: string; browser: string },
  ) {
    const directory = join(scratch, name);
    const manifests = {
      "nodejs-client": {
        name: "@questdb/nodejs-client",
        version: versions.nodejs,
      },
      "browser-client": {
        name: "@questdb/browser-client",
        version: versions.browser,
      },
    };
    for (const [pkg, manifest] of Object.entries(manifests)) {
      await mkdir(join(directory, "packages", pkg), { recursive: true });
      await writeFile(
        join(directory, "packages", pkg, "package.json"),
        JSON.stringify(manifest),
        "utf8",
      );
    }
    return directory;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "qwp-release-"));
    bin = join(scratch, "bin");
    await mkdir(bin);
    const npm = join(bin, "npm");
    await writeFile(npm, fakeNpm, "utf8");
    await chmod(npm, 0o755);
    root = await manifestRoot("release", {
      nodejs: PUBLISHED,
      browser: PUBLISHED,
    });
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const run = (gitHead: string, packages?: string, cwd = root) =>
    spawnSync(process.execPath, [script], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GITHUB_SHA: "release-commit",
        FAKE_NPM_GIT_HEAD: gitHead,
        RELEASE_PACKAGES: packages ?? "",
      },
    });

  it("resumes only a same-commit partial release", () => {
    const unrelated = run("older-commit");
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toContain("older unrelated artifact");
    expect(unrelated.stderr).toContain("Bump the version first");
    expect(unrelated.stderr).toContain("packages=browser");

    const resumable = run("release-commit");
    expect(resumable.status).toBe(0);
    expect(resumable.stderr).toContain("resuming a partial release");
    expect(resumable.stdout).toContain("release check passed");
  });

  it("publishes a selected package on its own", () => {
    // The Node package was released on its own from an earlier commit;
    // the browser package follows under the same version.
    const browserOnly = run("older-commit", "browser");
    expect(browserOnly.status).toBe(0);
    expect(browserOnly.stderr).not.toContain("resuming");
    expect(browserOnly.stdout).toContain(
      "release check passed (packages=browser): @questdb/browser-client@",
    );
    expect(browserOnly.stdout).not.toContain("@questdb/nodejs-client");

    // Everything selected is already on npm: a no-op dispatch. The package
    // still missing from npm is the one the follow-up should have selected.
    const nodeOnly = run("release-commit", "nodejs");
    expect(nodeOnly.status).toBe(1);
    expect(nodeOnly.stderr).toContain(
      "the selected package has already published",
    );
    expect(nodeOnly.stderr).not.toContain("every package");
    expect(nodeOnly.stderr).toContain("packages=browser");

    const unknown = run("release-commit", "node");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown RELEASE_PACKAGES value");
  });

  it("keeps the manifests in lockstep whatever the selection", async () => {
    const drifted = await manifestRoot("drifted", {
      nodejs: "5.1.0",
      browser: PUBLISHED,
    });
    for (const packages of ["both", "nodejs", "browser"]) {
      const result = run("release-commit", packages, drifted);
      expect(result.status, packages).toBe(1);
      expect(result.stderr, packages).toContain(
        "the published packages are on different versions",
      );
    }
  });
});
