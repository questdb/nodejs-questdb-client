import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Consumer-facing checks that run against the built packages instead of the
 * private core source.
 *
 * Each public package now emits one root entry. These checks ensure the legacy
 * Sender and the complete runtime-specific QWP surface coexist in that entry,
 * with one class/type identity per module format.
 *
 * Requires a build. Run with `pnpm test:dist`.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const NODE_PACKAGE = path.join(ROOT, "packages/nodejs-client");
const BROWSER_PACKAGE = path.join(ROOT, "packages/browser-client");
const require_ = createRequire(import.meta.url);

type Format = "import" | "require";

/** Resolves the Node package root through `exports`, as a consumer would. */
let resolveExport: (format: Format) => string;

beforeAll(async () => {
  const manifest = JSON.parse(
    await readFile(path.join(NODE_PACKAGE, "package.json"), "utf8"),
  ) as { exports: Record<string, Record<Format, { default: string }>> };
  const browserManifest = JSON.parse(
    await readFile(path.join(BROWSER_PACKAGE, "package.json"), "utf8"),
  ) as { exports: Record<string, Record<Format, { default: string }>> };

  resolveExport = (format) => {
    const target = manifest.exports["."]?.[format]?.default;
    if (!target) {
      throw new Error(`package.json exports has no '${format}' root target`);
    }
    return path.join(NODE_PACKAGE, target);
  };

  for (const format of ["import", "require"] as const) {
    const target = resolveExport(format);
    if (!existsSync(target)) {
      throw new Error(
        `${target} is missing - run 'pnpm build' before this suite`,
      );
    }
  }

  resolveBrowserExport = (format) => {
    const target = browserManifest.exports["."]?.[format]?.default;
    if (!target) {
      throw new Error(
        `browser package exports has no '${format}' target for '.'`,
      );
    }
    return path.join(BROWSER_PACKAGE, target);
  };
  for (const format of ["import", "require"] as const) {
    const target = resolveBrowserExport(format);
    if (!existsSync(target)) {
      throw new Error(
        `${target} is missing - run 'pnpm build' before this suite`,
      );
    }
  }
});

let resolveBrowserExport: (format: Format) => string;

const load = (format: Format) =>
  format === "require"
    ? Promise.resolve(require_(resolveExport(format)))
    : import(pathToFileURL(resolveExport(format)).href);

const loadBrowser = (format: Format) =>
  format === "require"
    ? Promise.resolve(require_(resolveBrowserExport(format)))
    : import(pathToFileURL(resolveBrowserExport(format)).href);

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
    it("exposes Sender and the complete Node QWP API at the root", async () => {
      const qwp: any = await load(format);
      const node: any = await load(format);
      const sender = node.createQwpNodeSender({ url: URL_, autoFlush: false });
      const trades = sender.writer("trades", schemaFrom(qwp));
      await stageTwoRows(trades);

      expect(sender.metrics.pendingRows).toBe(2);
    });

    it("exposes a self-contained browser writer at the package root", async () => {
      const browser: any = await loadBrowser(format);
      const sender = browser.createQwpBrowserSender({
        url: URL_,
        autoFlush: false,
      });
      const trades = sender.writer("trades", schemaFrom(browser));
      await stageTwoRows(trades);

      expect(sender.metrics.pendingRows).toBe(2);
    });

    it("keeps one writer and error identity within the package root", async () => {
      const root: any = await load(format);
      const qwp: any = await load(format);

      const sender = await root.Sender.fromConfig(
        "ws::addr=127.0.0.1:9;auto_flush=off;",
        { log: () => {} },
      );
      const node: any = await load(format);
      const trades = sender.writer("trades", schemaFrom(qwp));
      await stageTwoRows(trades);

      expect(sender.publishedSequence).toBe(-1n);
      expect(trades).toBeInstanceOf(qwp.QwpTableWriter);
      expect(trades).toBeInstanceOf(node.QwpTableWriter);

      let rowError: unknown;
      try {
        await trades.row({
          symbol: "SOL-USD",
          price: "not-a-number",
          timestamp: 3n,
        });
      } catch (error) {
        rowError = error;
      }
      expect(rowError).toBeInstanceOf(qwp.QwpWriterRowError);
      expect(rowError).toBeInstanceOf(node.QwpWriterRowError);

      const otherFormat = format === "import" ? "require" : "import";
      const otherNode: any = await load(otherFormat);
      expect(trades).not.toBeInstanceOf(otherNode.QwpTableWriter);
      expect(rowError).not.toBeInstanceOf(otherNode.QwpWriterRowError);
    });

    it("keeps synchronous package-root identity", async () => {
      const root: any = await load(format);
      const sender = new root.Sender(
        new root.SenderOptions("ws::addr=127.0.0.1:9;auto_flush=off;", {
          log: () => {},
        }),
      );
      const node: any = await load(format);
      const trades = sender.writer("trades", schemaFrom(node));

      expect(trades).toBeInstanceOf(node.QwpTableWriter);

      let rowError: unknown;
      try {
        await trades.row({
          symbol: "SOL-USD",
          price: "not-a-number",
          timestamp: 3n,
        });
      } catch (error) {
        rowError = error;
      }
      expect(rowError).toBeInstanceOf(node.QwpWriterRowError);
    });

    it("re-exported factories keep the root module identity", async () => {
      const qwp: any = await load(format);
      const node: any = await load(format);

      expect(node.symbol).toBe(qwp.symbol);

      // A descriptor obtained through any root reference must be accepted by
      // the writer from that same emitted module.
      const sender = node.createQwpNodeSender({ url: URL_, autoFlush: false });
      for (const factories of [qwp, node]) {
        expect(() =>
          sender.writer("trades", schemaFrom(factories)),
        ).not.toThrow();
      }
    });
  },
);

describe("package-root static QWP import", () => {
  it("uses only the ESM root for synchronous ESM construction", async () => {
    const rootUrl = pathToFileURL(resolveExport("import")).href;
    const nodeUrl = pathToFileURL(resolveExport("import")).href;
    const commonJsNode = resolveExport("require");
    const configuration = "ws::addr=127.0.0.1:9;auto_flush=off;";
    const script = `
      (async () => {
        const root = await import(${JSON.stringify(rootUrl)});
        const commonJsLoaded = Boolean(require.cache[require.resolve(${JSON.stringify(commonJsNode)})]);
        const node = await import(${JSON.stringify(nodeUrl)});
        const sender = new root.Sender(
          new root.SenderOptions(${JSON.stringify(configuration)}, { log: () => {} }),
        );
        const writer = sender.writer("trades", (${schemaFrom.toString()})(node));
        let rowError;
        try {
          await writer.row({ symbol: "SOL-USD", price: "not-a-number", timestamp: 3n });
        } catch (error) {
          rowError = error;
        }

        console.log(JSON.stringify({
          commonJsLoaded,
          writerIdentity: writer instanceof node.QwpTableWriter,
          errorIdentity: rowError instanceof node.QwpWriterRowError,
        }));
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;

    const { code, stdout, stderr } = await runNode(script);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      commonJsLoaded: false,
      writerIdentity: true,
      errorIdentity: true,
    });
  });
});

describe("store-and-forward locking", () => {
  it.each(["import", "require"] as const)(
    "loads QWP with the package root (%s)",
    async (format) => {
      const target = resolveExport(format);
      const probe =
        '({ ws: !!require.cache[require.resolve("ws")],' +
        " dgram: process.moduleLoadList.some((m) => /dgram/.test(m)) })";
      const body =
        `const before = ${probe};` +
        ' const http = await Sender.fromConfig("http::addr=127.0.0.1:9000;protocol_version=1;");' +
        ` const afterHttp = ${probe};` +
        " await http.close();" +
        ' const sender = await Sender.fromConfig("udp::addr=127.0.0.1:9007;");' +
        ` const afterQwp = ${probe};` +
        " await sender.close();" +
        " console.log(JSON.stringify({ before, afterHttp, afterQwp, table: typeof sender.table }));";
      const load_ =
        format === "require"
          ? `(async () => { const { Sender } = require(${JSON.stringify(target)}); ${body} })();`
          : `import(${JSON.stringify(pathToFileURL(target).href)}).then(async ({ Sender }) => { ${body} });`;

      const { code, stdout, stderr } = await runNode(load_);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        before: { ws: format === "require", dgram: true },
        afterHttp: { ws: format === "require", dgram: true },
        // ESM-loaded CommonJS dependencies are not exposed through
        // require.cache; dgram is the format-independent QWP graph probe.
        afterQwp: { ws: format === "require", dgram: true },
        table: "function",
      });
    },
  );

  it.each(["import", "require"] as const)(
    "the package root loads (%s) on a platform no addon would support",
    async (format) => {
      const target = resolveExport(format);
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

  it("ships the slot lock in the bundle with no native addon", async () => {
    for (const format of ["import", "require"] as const) {
      const bundle = await readFile(resolveExport(format), "utf8");

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
      await readFile(
        new URL("../../packages/nodejs-client/package.json", import.meta.url),
        "utf8",
      ),
    );

    expect(manifest.optionalDependencies).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "undici",
      "ws",
    ]);
  });
});
