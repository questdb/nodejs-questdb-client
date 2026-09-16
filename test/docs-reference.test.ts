import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as nodeClient from "../packages/nodejs-client/src";
import * as browserClient from "../packages/browser-client/src";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");

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
    for (const [moduleName, module] of [
      ["_questdb_nodejs-client", nodeClient],
      ["_questdb_browser-client", browserClient],
    ] as const) {
      for (const name of Object.keys(module)) {
        if (!pages.has(`${moduleName}.${name}`)) {
          missing.push(`${moduleName}.${name}`);
        }
      }
    }

    expect(missing.sort()).toEqual([]);
  });
});
