import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const fakeNpm = `#!/usr/bin/env node
const [, , command, specifier, field] = process.argv;
if (command !== "view") process.exit(2);
if (field === "versions") {
  console.log(specifier === "@questdb/nodejs-client" ? '["5.0.0"]' : '[]');
} else if (
  specifier === "@questdb/nodejs-client@5.0.0" &&
  field === "gitHead"
) {
  console.log(JSON.stringify(process.env.FAKE_NPM_GIT_HEAD));
} else {
  process.exit(2);
}
`;

describe("release version gate", () => {
  it.skipIf(process.platform === "win32")(
    "resumes only a same-commit partial release",
    async () => {
      const bin = await mkdtemp(join(tmpdir(), "qwp-release-npm-"));
      const npm = join(bin, "npm");
      await writeFile(npm, fakeNpm, "utf8");
      await chmod(npm, 0o755);

      const run = (gitHead: string) =>
        spawnSync(process.execPath, ["scripts/check-release-versions.mjs"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            GITHUB_SHA: "release-commit",
            FAKE_NPM_GIT_HEAD: gitHead,
          },
        });

      try {
        const unrelated = run("older-commit");
        expect(unrelated.status).toBe(1);
        expect(unrelated.stderr).toContain("older unrelated artifact");
        expect(unrelated.stderr).toContain("Bump the version first");

        const resumable = run("release-commit");
        expect(resumable.status).toBe(0);
        expect(resumable.stderr).toContain("resuming a partial release");
        expect(resumable.stdout).toContain("release check passed");
      } finally {
        await rm(bin, { recursive: true, force: true });
      }
    },
  );
});
