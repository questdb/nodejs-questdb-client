import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const ENTRY_POINTS = [
  ["_questdb_nodejs-client", "packages/nodejs-client/src/index.ts"],
  ["_questdb_browser-client", "packages/browser-client/src/index.ts"],
] as const;

// The generated TypeDoc reference is committed, and GitHub Pages serves it
// straight from the branch (docs/.nojekyll, plus the `homepage` both manifests
// declare). Nothing regenerated or verified it, so it drifted: the committed
// tree was built 33 commits before the branch tip, which left it with no page
// for an exported error class and a copy of QWP.md 114 lines behind the real
// one. Run `pnpm run docs` to refresh it.
//
// A byte-for-byte "regenerate and diff" gate cannot work here: TypeDoc embeds
// the commit SHA in every source link, so the output necessarily differs from
// whatever was committed one commit earlier. These two checks are the
// deterministic part of that invariant -- both would have failed on the drift,
// and neither can be defeated by SHA or reflection-id churn.

/**
 * Every name a package root exports, including the type-only ones.
 *
 * `Object.keys()` on the imported module cannot see them: TypeScript erases
 * `export type`, so a module namespace holds the runtime values alone. That is
 * most of the public QWP surface -- the option interfaces, the writer schema
 * types, the result and bind unions -- and it is exactly the part of the
 * generated reference a reader has to look up rather than infer, so the check
 * below was blind to precisely the pages that matter most. TypeDoc enumerates
 * the same module symbols this does.
 */
function moduleExports(entry: string): string[] {
  const file = path.join(ROOT, entry);
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`cannot inspect exports of ${entry}`);
  return checker
    .getExportsOfModule(module)
    .map((symbol) => symbol.name)
    .sort();
}

/** Page basenames TypeDoc emitted, e.g. `_questdb_nodejs-client.Sender`. */
async function documentedPages(): Promise<Set<string>> {
  const kinds = ["classes", "functions", "interfaces", "types", "variables"];
  const pages = new Set<string>();
  for (const kind of kinds) {
    let entries: string[];
    try {
      entries = await readdir(path.join(DOCS, kind));
    } catch {
      continue; // A kind with no members emits no directory.
    }
    for (const entry of entries) {
      if (entry.endsWith(".html")) pages.add(entry.slice(0, -".html".length));
    }
  }
  return pages;
}

describe("generated API reference", () => {
  it("embeds the current QWP.md rather than an older copy", async () => {
    // `readme`/`media` copies are verbatim, so this is an exact comparison.
    const [source, embedded] = await Promise.all([
      readFile(path.join(ROOT, "QWP.md"), "utf8"),
      readFile(path.join(DOCS, "media", "QWP.md"), "utf8"),
    ]);

    // Compare lengths first: a full-text diff of 1800 lines is unreadable.
    expect(embedded.split("\n").length).toBe(source.split("\n").length);
    expect(embedded).toBe(source);
  });

  it("has a page for every symbol the packages export", async () => {
    const pages = await documentedPages();
    expect(pages.size).toBeGreaterThan(100);

    const missing: string[] = [];
    let inspected = 0;
    for (const [moduleName, entry] of ENTRY_POINTS) {
      const exports = moduleExports(entry);
      // Guards the enumeration itself: a resolution failure that returned an
      // empty list would otherwise pass this test silently.
      expect(exports.length).toBeGreaterThan(100);
      inspected += exports.length;
      for (const name of exports) {
        if (!pages.has(`${moduleName}.${name}`)) {
          missing.push(`${moduleName}.${name}`);
        }
      }
    }

    expect(missing.sort()).toEqual([]);
    // Type-only exports are the majority of the surface, so a regression back
    // to runtime-only enumeration would drop the count well below this.
    expect(inspected).toBeGreaterThan(500);
  });
});
