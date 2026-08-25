import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Consumer-facing checks that run against the built package instead of `src/`.
 *
 * Every other suite imports from `src/`, where all four entry points resolve to
 * one module instance. The published package emits one bundle per entry point,
 * so module-private state is duplicated per bundle and cross-entry-point usage
 * can break in ways `src/`-level tests structurally cannot observe. The
 * compiled writer regression these tests cover is exactly that: the column
 * factories live only in `./qwp`, while `writer()` lives on senders built from
 * `./qwp/node`, `./qwp/browser`, and the package root.
 *
 * Requires a build. Run with `pnpm test:dist`.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require_ = createRequire(import.meta.url);

type Subpath = "." | "./qwp" | "./qwp/browser" | "./qwp/node";
type Format = "import" | "require";

/** Resolves a subpath through package.json `exports`, as a consumer would. */
let resolveExport: (subpath: Subpath, format: Format) => string;

beforeAll(async () => {
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, Record<Format, { default: string }>> };

  resolveExport = (subpath, format) => {
    const target = manifest.exports[subpath]?.[format]?.default;
    if (!target) {
      throw new Error(
        `package.json exports has no '${format}' target for '${subpath}'`,
      );
    }
    return path.join(ROOT, target);
  };

  for (const subpath of [
    ".",
    "./qwp",
    "./qwp/browser",
    "./qwp/node",
  ] as const) {
    for (const format of ["import", "require"] as const) {
      const target = resolveExport(subpath, format);
      if (!existsSync(target)) {
        throw new Error(
          `${target} is missing - run 'pnpm build' before this suite`,
        );
      }
    }
  }
});

const load = (subpath: Subpath, format: Format) =>
  format === "require"
    ? Promise.resolve(require_(resolveExport(subpath, format)))
    : import(pathToFileURL(resolveExport(subpath, format)).href);

/* eslint-disable @typescript-eslint/no-explicit-any */
const schemaFrom = (factories: any) => ({
  symbol: factories.symbol(),
  price: factories.double(),
  timestamp: factories.designatedTimestamp("ns"),
});

const stageTwoRows = async (writer: any) => {
  await writer.row({ symbol: "ETH-USD", price: 2615.54, timestamp: 1n });
  await writer.rows([{ symbol: "BTC-USD", price: 39_269.98, timestamp: 2n }]);
};

const URL_ = "ws://127.0.0.1:9/write/v4";

describe.each(["import", "require"] as const)(
  "built package (%s)",
  (format) => {
    // The factories are exported only from './qwp', so every real use of a
    // compiled writer crosses at least one entry-point boundary.
    it.each(["./qwp/browser", "./qwp/node"] as const)(
      "compiles a writer on a %s sender from './qwp' column factories",
      async (senderSubpath) => {
        const qwp: any = await load("./qwp", format);
        const entry: any = await load(senderSubpath, format);
        const create =
          senderSubpath === "./qwp/node"
            ? entry.createQwpNodeSender
            : entry.createQwpBrowserSender;

        const sender = create({ url: URL_, autoFlush: false });
        const trades = sender.writer("trades", schemaFrom(qwp));
        await stageTwoRows(trades);

        expect(sender.metrics.pendingRows).toBe(2);
      },
    );

    it("compiles a writer on the package-root Sender", async () => {
      const root: any = await load(".", format);
      const qwp: any = await load("./qwp", format);

      const sender = await root.Sender.fromConfig(
        "ws::addr=127.0.0.1:9;auto_flush=off;",
        { log: () => {} },
      );
      const trades = sender.writer("trades", schemaFrom(qwp));
      await stageTwoRows(trades);

      expect(sender.publishedSequence).toBe(-1n);
    });

    it("re-exported factories keep the identity of their defining bundle", async () => {
      const qwp: any = await load("./qwp", format);
      const node: any = await load("./qwp/node", format);
      const browser: any = await load("./qwp/browser", format);

      // './qwp/node' and './qwp/browser' re-export the factories with
      // `export * from "./index"`, so they must be the very same functions.
      expect(node.symbol).toBe(qwp.symbol);
      expect(browser.symbol).toBe(qwp.symbol);

      // ...and a descriptor built through any of them must be accepted by a
      // writer compiled in any other bundle. This is the assertion that fails
      // when the column brand is a module-private Symbol rather than a shared
      // one: the factory and the validator end up in different bundles.
      const sender = node.createQwpNodeSender({ url: URL_, autoFlush: false });
      for (const factories of [qwp, node, browser]) {
        expect(() =>
          sender.writer("trades", schemaFrom(factories)),
        ).not.toThrow();
      }
    });
  },
);

describe("store-and-forward locking", () => {
  const runNode = (script: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = execFile(
          process.execPath,
          ["-e", script],
          (error, stdout, stderr) =>
            resolve({
              code: error ? ((error as { code?: number }).code ?? 1) : 0,
              stdout,
              stderr,
            }),
        );
        child.on("error", () =>
          resolve({ code: 1, stdout: "", stderr: "spawn failed" }),
        );
      },
    );

  it.each(["import", "require"] as const)(
    "the package root loads (%s) on a platform no addon would support",
    async (format) => {
      const target = resolveExport(".", format);
      const load_ =
        format === "require"
          ? `console.log(typeof require(${JSON.stringify(target)}).Sender)`
          : `import(${JSON.stringify(pathToFileURL(target).href)}).then(m => console.log(typeof m.Sender))`;

      // Spoofing an exotic platform is what a native addon's loader keys off.
      // The slot lock is pure JavaScript now, so this must stay boring - it
      // guards against a native dependency creeping back onto the root entry's
      // module graph, where it would break every HTTP/TCP user on musl, a
      // future Node major, or an unusual architecture.
      const { code, stdout, stderr } = await runNode(
        `Object.defineProperty(process,'platform',{value:'sunos'});${load_}`,
      );

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("function");
    },
  );

  it.each(["import", "require"] as const)(
    "loads the QWP Node subsystem only when a ws/wss/udp sender is built (%s)",
    async (format) => {
      // The root entry must not eagerly pull ws, node:dgram and node:os onto
      // the module graph: http/tcp consumers -- the bulk of callers -- would
      // pay for the whole QWP Node subsystem and hard-depend on ws resolving.
      // It must still load lazily and work on the first ws/wss/udp sender.
      const target = resolveExport(".", format);
      const probe =
        '({ ws: !!require.cache[require.resolve("ws")],' +
        " dgram: process.moduleLoadList.some((m) => /dgram/.test(m)) })";
      const body =
        `const before = ${probe};` +
        ' const sender = new Sender({ protocol: "udp", host: "127.0.0.1", port: 9007 });' +
        ` const after = ${probe};` +
        " console.log(JSON.stringify({ before, after, table: typeof sender.table }));";
      const load_ =
        format === "require"
          ? `const { Sender } = require(${JSON.stringify(target)}); ${body}`
          : `import(${JSON.stringify(pathToFileURL(target).href)}).then(({ Sender }) => { ${body} });`;

      const { code, stdout, stderr } = await runNode(load_);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(stdout.trim());
      // Root load alone leaves the QWP Node subsystem off the graph.
      expect(result.before).toEqual({ ws: false, dgram: false });
      // The first ws/wss/udp sender lazily loads it, and is functional.
      expect(result.after).toEqual({ ws: true, dgram: true });
      expect(result.table).toBe("function");
    },
  );

  it("ships the slot lock in the bundle with no native addon", async () => {
    for (const format of ["import", "require"] as const) {
      const bundle = await readFile(
        resolveExport("./qwp/node", format),
        "utf8",
      );

      // The `.lock.owner` mutex is the whole locking implementation, so it must
      // be inlined rather than reached through any external specifier.
      expect(bundle).toContain('".owner"');
      expect(bundle).toContain('".slot-locks"');
      // Nothing may pull in a compiled binary: a prebuilt addon is exactly the
      // per-Node-major breakage this lock exists to avoid.
      expect(bundle).not.toMatch(/fs-ext/);
      expect(bundle).not.toMatch(/['"][^'"]*\.node['"]\s*\)/);
    }
  });

  it("declares no optional or native dependencies", async () => {
    const manifest: {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    } = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );

    expect(manifest.optionalDependencies).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "undici",
      "ws",
    ]);
  });
});
