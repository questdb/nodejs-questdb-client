// Verifies every public export, declaration, and relative runtime dependency
// exists in the package directory and is included by `npm pack`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const PACKAGES = ["packages/nodejs-client", "packages/browser-client"];
const SPECIFIER =
  /(?:\bfrom|\brequire\(|\bimport\()\s*["'](\.[^"']*\.(?:d\.)?[mc]?[jt]s)["']/g;

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function checkPackage(packageDirectory) {
  const manifest = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
  const missing = [];
  const seen = new Set();

  const walk = (target, from) => {
    const file = resolve(packageDirectory, target);
    if (!existsSync(file)) {
      missing.push(`${from} -> ${relative(packageDirectory, file)}`);
      return;
    }
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      walk(join(dirname(relative(packageDirectory, file)), specifier), target);
    }
  };

  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    for (const target of exportTargets(conditions)) walk(target, subpath);
  }
  for (const [subpath, targets] of Object.entries(
    manifest.typesVersions?.["*"] ?? {},
  )) {
    for (const target of targets) walk(target, `typesVersions ${subpath}`);
  }

  let pack;
  try {
    [pack] = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", "--dry-run", "--json"],
        {
          cwd: packageDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new Error(
      `${manifest.name}: npm pack --dry-run failed${stderr ? `:\n${stderr}` : ""}`,
    );
  }

  if (!Array.isArray(pack?.files)) {
    throw new Error(`${manifest.name}: npm pack returned no file manifest`);
  }
  const packedFiles = new Set(pack.files.map(({ path }) => path));
  for (const file of seen) {
    const packagePath = relative(packageDirectory, file).split(sep).join("/");
    if (!packedFiles.has(packagePath)) {
      missing.push(`npm pack omits ${packagePath}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`${manifest.name}:\n  ${missing.join("\n  ")}`);
  }
  console.log(
    `${manifest.name}: ${Object.keys(manifest.exports).length} export subpaths, ${seen.size} linked files present and packed`,
  );
}

try {
  for (const packageDirectory of PACKAGES) checkPackage(packageDirectory);
} catch (error) {
  console.error(`missing build artifacts:\n${error.message}`);
  process.exit(1);
}
