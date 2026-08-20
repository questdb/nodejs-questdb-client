import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QWP_SUPPORTED_CONFIG_KEYS } from "../../src/qwp-node/client-config";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("QWP configuration-string reference", () => {
  it("documents every key the parser accepts", async () => {
    // A key the parser takes but QWP.md never names is undiscoverable: the
    // connect string is the portable spelling shared with the other QuestDB
    // clients, so the reference has to track the schema.
    const doc = await readFile(path.join(ROOT, "QWP.md"), "utf8");
    const undocumented = [...QWP_SUPPORTED_CONFIG_KEYS]
      .filter((key) => !doc.includes(`\`${key}\``))
      .sort();

    expect(undocumented).toEqual([]);
  });

  it("does not document keys the parser rejects", async () => {
    // The reference tables are the only place these back-ticked snake_case
    // names appear, so anything listed there must really be accepted.
    const doc = await readFile(path.join(ROOT, "QWP.md"), "utf8");
    const start = doc.indexOf("## Configuration-string keys");
    const section = doc.slice(
      start,
      doc.indexOf("\n### Node.js fire-and-forget UDP", start),
    );
    const listed = new Set(
      [
        ...section.matchAll(/^\| `([a-z0-9_]+)`(?:, `([a-z0-9_]+)`)?/gm),
      ].flatMap((match) => [match[1], match[2]].filter(Boolean) as string[]),
    );

    const unknown = [...listed]
      .filter((key) => !QWP_SUPPORTED_CONFIG_KEYS.has(key))
      .sort();

    expect(unknown).toEqual([]);
    // Guard against the extraction silently matching nothing.
    expect(listed.size).toBeGreaterThan(50);
  });
});
