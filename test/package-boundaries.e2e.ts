import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_PACKAGE = path.join(ROOT, "packages/nodejs-client");
const BROWSER_PACKAGE = path.join(ROOT, "packages/browser-client");
const require_ = createRequire(import.meta.url);
interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  files: string[];
  repository: { directory: string };
  exports: Record<string, Record<string, { types?: string; default?: string }>>;
}

interface PackedFile {
  path: string;
}

let nodeManifest: PackageManifest;
let browserManifest: PackageManifest;
let nodePackedFiles: Set<string>;
let browserPackedFiles: Set<string>;
let consumerDirectory: string;

async function manifest(directory: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
}

function packedFiles(directory: string): Set<string> {
  const [pack] = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json"],
      { cwd: directory, encoding: "utf8" },
    ),
  ) as [{ files: PackedFile[] }];
  return new Set(pack.files.map((file) => file.path));
}

function exportTarget(
  directory: string,
  packageManifest: PackageManifest,
  subpath: string,
  format: "import" | "require",
): string {
  const target = packageManifest.exports[subpath]?.[format]?.default;
  if (!target) throw new Error(`${packageManifest.name} ${subpath} ${format}`);
  return path.join(directory, target);
}

async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(file)));
    else result.push(file);
  }
  return result;
}

function moduleSpecifiers(source: string, file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
  );
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

beforeAll(async () => {
  [nodeManifest, browserManifest] = await Promise.all([
    manifest(NODE_PACKAGE),
    manifest(BROWSER_PACKAGE),
  ]);
  nodePackedFiles = packedFiles(NODE_PACKAGE);
  browserPackedFiles = packedFiles(BROWSER_PACKAGE);

  consumerDirectory = await mkdtemp(
    path.join(tmpdir(), "questdb-package-consumer-"),
  );
  const scope = path.join(consumerDirectory, "node_modules/@questdb");
  await mkdir(scope, { recursive: true });
  await Promise.all([
    symlink(NODE_PACKAGE, path.join(scope, "nodejs-client"), "junction"),
    symlink(BROWSER_PACKAGE, path.join(scope, "browser-client"), "junction"),
  ]);
});

afterAll(async () => {
  if (consumerDirectory) {
    await rm(consumerDirectory, { recursive: true, force: true });
  }
});

describe("public npm package boundaries", () => {
  it("packs two self-contained public packages without workspace sources", () => {
    for (const files of [nodePackedFiles, browserPackedFiles]) {
      expect(files).toContain("package.json");
      expect(files).toContain("README.md");
      expect(files).toContain("THIRD_PARTY_NOTICES.md");
      expect([...files]).toContainEqual(expect.stringMatching(/^dist\//));
      expect([...files]).not.toContainEqual(expect.stringMatching(/^src\//));
      expect([...files]).not.toContainEqual(
        expect.stringContaining("client-core"),
      );
      expect([...files]).not.toContainEqual(
        expect.stringMatching(/node_modules/),
      );
    }
  });

  it("keeps runtime metadata on the correct package", () => {
    expect(nodeManifest.name).toBe("@questdb/nodejs-client");
    expect(nodeManifest.files).toEqual([
      "dist",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ]);
    expect(nodeManifest.repository.directory).toBe("packages/nodejs-client");
    expect(Object.keys(nodeManifest.exports)).toEqual(["."]);
    // Must not sit below what the runtime dependencies themselves allow, or
    // the package advertises a Node range it cannot install on: undici 7.x
    // declares >=20.18.1, so a plain ">=20" warned with EBADENGINE and failed
    // outright under engine-strict.
    expect(nodeManifest.engines?.node).toBe(">=20.18.1");
    expect(Object.keys(nodeManifest.dependencies ?? {}).sort()).toEqual([
      "undici",
      "ws",
    ]);

    expect(browserManifest.name).toBe("@questdb/browser-client");
    expect(browserManifest.files).toEqual([
      "dist",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ]);
    expect(browserManifest.repository.directory).toBe(
      "packages/browser-client",
    );
    expect(Object.keys(browserManifest.exports)).toEqual(["."]);
    expect(browserManifest.engines?.node).toBeUndefined();
    expect(browserManifest.dependencies).toEqual({});
    expect(browserManifest.devDependencies).toBeUndefined();
  });

  it.each(["import", "require"] as const)(
    "loads every public package entry with %s",
    async (format) => {
      const load = (target: string) =>
        format === "require"
          ? Promise.resolve(require_(target))
          : import(pathToFileURL(target).href);

      const root = await load(
        exportTarget(NODE_PACKAGE, nodeManifest, ".", format),
      );
      const browser = await load(
        exportTarget(BROWSER_PACKAGE, browserManifest, ".", format),
      );

      expect(root.Sender).toBeTypeOf("function");
      expect(root.QwpSender).toBeTypeOf("function");
      expect(root.connectQwpNodeClient).toBeTypeOf("function");
      expect(browser.connectQwpBrowserClient).toBeTypeOf("function");
      expect(browser.QwpSender).toBeTypeOf("function");
    },
  );

  it.each(["import", "require"] as const)(
    "resolves package-name imports with the %s condition",
    (format) => {
      const expressions = [
        '"@questdb/nodejs-client"',
        '"@questdb/browser-client"',
      ];
      const script =
        format === "require"
          ? `const [node, browser] = [${expressions.map((specifier) => `require(${specifier})`).join(",")}]; console.log([typeof node.Sender, typeof node.connectQwpNodeClient, typeof browser.connectQwpBrowserClient].join(","));`
          : `const [node, browser] = await Promise.all([${expressions.map((specifier) => `import(${specifier})`).join(",")}]); console.log([typeof node.Sender, typeof node.connectQwpNodeClient, typeof browser.connectQwpBrowserClient].join(","));`;
      const output = execFileSync(
        process.execPath,
        format === "import"
          ? ["--input-type=module", "--eval", script]
          : ["--eval", script],
        { cwd: consumerDirectory, encoding: "utf8" },
      );
      expect(output.trim()).toBe("function,function,function");
    },
  );

  it.each(["import", "require"] as const)(
    "resolves the browser package under the browser condition with %s",
    (format) => {
      // jest-environment-jsdom adds `browser` to the export conditions while
      // still emitting require(), and so does `node --conditions=browser`.
      // Conditions match in declaration order, so a `browser` key that resolves
      // straight to the ESM file hands a CommonJS require an .mjs and Node
      // below 22.12 fails with ERR_REQUIRE_ESM. `browser` must therefore split
      // on import/require the same way the top-level map does.
      const script =
        format === "require"
          ? 'console.log(typeof require("@questdb/browser-client").connectQwpBrowserClient);'
          : 'console.log(typeof (await import("@questdb/browser-client")).connectQwpBrowserClient);';
      const output = execFileSync(
        process.execPath,
        format === "import"
          ? ["--conditions=browser", "--input-type=module", "--eval", script]
          : ["--conditions=browser", "--eval", script],
        { cwd: consumerDirectory, encoding: "utf8" },
      );
      expect(output.trim()).toBe("function");
    },
  );

  it("bundles the browser package root for a browser consumer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "questdb-browser-"));
    const bundle = path.join(directory, "client.mjs");
    try {
      execFileSync(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        [
          "exec",
          "rollup",
          exportTarget(BROWSER_PACKAGE, browserManifest, ".", "import"),
          "--format",
          "es",
          "--file",
          bundle,
          "--silent",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      const source = await readFile(bundle, "utf8");
      expect(source).toContain("connectQwpBrowserClient");
      expect(source).not.toMatch(/^\s*(?:import|export).*?from\s/m);
      expect(source).not.toMatch(/\brequire\s*\(/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ships a closed browser module graph with no Node modules or typings", async () => {
    const builtins = new Set(
      builtinModules.flatMap((name) => [name, `node:${name}`]),
    );
    const forbiddenPackages = new Set(["ws", "undici"]);
    const files = (await filesBelow(path.join(BROWSER_PACKAGE, "dist"))).filter(
      (file) => /\.(?:[mc]?js|d\.(?:ts|mts))$/.test(file),
    );

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/<reference\s+types=["']node["']/);
      expect(source, file).not.toMatch(/\bNodeJS\./);
      expect(source, file).not.toMatch(/(?:from|import\()["']@types\/node/);

      for (const specifier of moduleSpecifiers(source, file)) {
        expect(builtins.has(specifier), `${file}: ${specifier}`).toBe(false);
        expect(
          [...forbiddenPackages].some(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          ),
          `${file}: ${specifier}`,
        ).toBe(false);
        expect(specifier.startsWith("."), `${file}: ${specifier}`).toBe(true);
        expect(
          existsSync(path.resolve(path.dirname(file), specifier)),
          `${file}: unresolved ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
