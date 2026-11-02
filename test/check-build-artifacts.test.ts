import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/check-build-artifacts.mjs");
const packages = ["nodejs-client", "browser-client"];
const fakeNpm = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
if (process.argv.slice(2).join(" ") !== "pack --dry-run --json") process.exit(2);
if (process.env.FAKE_NPM_PACK_FAIL) {
  console.error("npm error fixture pack failure");
  process.exit(1);
}
if (process.env.FAKE_NPM_PACK_RESULT) {
  console.log(process.env.FAKE_NPM_PACK_RESULT);
} else {
  const { name } = JSON.parse(readFileSync("package.json", "utf8"));
  const files = ["dist/index.js", "dist/index.d.ts", "dist/chunk.js"]
    .filter((path) => path !== process.env.FAKE_NPM_PACK_OMIT)
    .map((path) => ({ path }));
  const pack = { name, files };
  console.log(JSON.stringify(
    process.env.FAKE_NPM_PACK_FORMAT === "object" ? { [name]: pack } : [pack],
  ));
}
`;

describe.skipIf(process.platform === "win32")("build artifact gate", () => {
  let root: string;
  let bin: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "questdb-build-artifacts-"));
    bin = join(root, "bin");
    await mkdir(bin);
    const npm = join(bin, "npm");
    await writeFile(npm, fakeNpm);
    await chmod(npm, 0o755);
    for (const name of packages) {
      const directory = join(root, "packages", name);
      await mkdir(join(directory, "dist"), { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: `@questdb/${name}`,
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        }),
      );
      await writeFile(
        join(directory, "dist/index.js"),
        'export { value } from "./chunk.js";',
      );
      await writeFile(
        join(directory, "dist/chunk.js"),
        "export const value = 1;",
      );
      await writeFile(
        join(directory, "dist/index.d.ts"),
        "export declare const value: number;",
      );
    }
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        ...env,
      },
    });

  it.each(["array", "object"])(
    "accepts npm pack's %s output for both packages",
    (format) => {
      const result = run({ FAKE_NPM_PACK_FORMAT: format });
      expect(result.status, result.stderr).toBe(0);
      for (const name of packages) {
        expect(result.stdout).toContain(
          `@questdb/${name}: 1 export subpaths, 3 linked files present and packed`,
        );
      }
    },
  );

  it.each(["array", "object"])(
    "rejects an unpacked runtime dependency with %s output",
    (format) => {
      const result = run({
        FAKE_NPM_PACK_FORMAT: format,
        FAKE_NPM_PACK_OMIT: "dist/chunk.js",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm pack omits dist/chunk.js");
    },
  );

  it.each(["[]", "{}", "[{}]", '{"@questdb/nodejs-client":{}}'])(
    "rejects a missing file manifest in %s",
    (output) => {
      const result = run({ FAKE_NPM_PACK_RESULT: output });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm pack returned no file manifest");
    },
  );

  it("reports npm pack failures", () => {
    const result = run({ FAKE_NPM_PACK_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm pack --dry-run failed");
    expect(result.stderr).toContain("npm error fixture pack failure");
  });
});
