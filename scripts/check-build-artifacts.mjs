// Verifies that every package `exports` target exists, and that the shared
// chunks those entries import were published too. Entry bundles import chunks
// that no `exports` entry names, so a chunk left out of `files` would publish a
// package whose every entry resolves to a missing file.
//
// This lives in a file rather than inline in the workflow because the pattern
// below needs both quote characters, which cannot survive a single-quoted
// `node -e` argument in a YAML block scalar.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Only specifiers that name an emitted file. Matching every `from "./x"` in the
// raw text would also match prose inside a comment the bundler preserved -- a
// sentence such as "the factories from './qwp'" is not an import, and treating
// it as one reports a build artifact that was never meant to exist.
const SPECIFIER =
  /(?:\bfrom|\brequire\(|\bimport\()\s*["'](\.[^"']*\.(?:d\.)?[mc]?[jt]s)["']/g;

const { exports: map } = JSON.parse(readFileSync("package.json", "utf8"));

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

if (missing.length > 0) {
  console.error(`missing build artifacts:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `all ${Object.keys(map).length} export subpaths present, ${seen.size} files walked`,
);
