// Verifies that every package `exports` target exists and is included by
// `npm pack`, along with every shared chunk those entries import. Entry bundles
// import chunks that no `exports` entry names, so checking only the untarred
// tree would miss a chunk left out of `files` and publish broken entry points.
//
// This lives in a file rather than inline in the workflow because the pattern
// below needs both quote characters, which cannot survive a single-quoted
// `node -e` argument in a YAML block scalar.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";

// Only specifiers that name an emitted file. Matching every `from "./x"` in the
// raw text would also match prose inside a comment the bundler preserved -- a
// sentence such as "the factories from './qwp'" is not an import, and treating
// it as one reports a build artifact that was never meant to exist.
const SPECIFIER =
  /(?:\bfrom|\brequire\(|\bimport\()\s*["'](\.[^"']*\.(?:d\.)?[mc]?[jt]s)["']/g;

const { exports: map, typesVersions } = JSON.parse(
  readFileSync("package.json", "utf8"),
);

const missing = [];
const seen = new Set();

const walk = (file, from) => {
  if (!existsSync(file)) {
    missing.push(`${from} -> ${file}`);
    return;
  }
  const key = resolve(file);
  if (seen.has(key)) return;
  seen.add(key);
  const source = readFileSync(file, "utf8");
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    walk(join(dirname(file), specifier), file);
  }
};

for (const [subpath, conditions] of Object.entries(map)) {
  for (const target of Object.values(conditions)) {
    for (const file of Object.values(target)) {
      walk(file, subpath);
    }
  }
}

// typesVersions is what TypeScript's legacy node10 resolution reads instead of
// `exports`, so a target missing here breaks those consumers with a TS2307 that
// no runtime test can see.
for (const [subpath, targets] of Object.entries(typesVersions?.["*"] ?? {})) {
  for (const target of targets) {
    walk(target, `typesVersions ${subpath}`);
  }
}

if (missing.length > 0) {
  console.error(`missing build artifacts:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

let pack;
try {
  [pack] = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
} catch (error) {
  const stderr = error?.stderr?.toString().trim();
  console.error(`npm pack --dry-run failed${stderr ? `:\n${stderr}` : ""}`);
  process.exit(1);
}

if (!Array.isArray(pack?.files)) {
  console.error("npm pack --dry-run returned no package file manifest");
  process.exit(1);
}

const packedFiles = new Set(pack.files.map(({ path }) => path));
for (const file of seen) {
  const packagePath = relative(process.cwd(), file).split(sep).join("/");
  if (!packedFiles.has(packagePath)) {
    missing.push(`npm pack omits ${packagePath}`);
  }
}

if (missing.length > 0) {
  console.error(`missing build artifacts:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `all ${Object.keys(map).length} export subpaths present, ${seen.size} files walked and packed`,
);
