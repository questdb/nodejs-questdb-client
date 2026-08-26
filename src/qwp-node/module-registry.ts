import { createRequire } from "node:module";

type QwpNodeModule = typeof import("../qwp/node");

let qwpNodeModule: QwpNodeModule | undefined;
let qwpNodeModulePromise: Promise<QwpNodeModule> | undefined;

/**
 * Loads the QWP Node entry through the current bundle's module format and
 * retains that exact namespace for every root-entry QWP call site.
 *
 * Bunchee rewrites the relative import to `qwp/node.mjs` in the ESM root and
 * `qwp/node.js` in the CommonJS root. Awaiting this before a QWP SenderOptions
 * or Sender is constructed therefore preserves constructor identity with the
 * documented same-format `qwp/node` entry without putting it on the eager root
 * module graph.
 */
export async function preloadQwpNodeModule(): Promise<void> {
  if (qwpNodeModule) return;
  const loading =
    qwpNodeModulePromise ??
    (qwpNodeModulePromise = import("../qwp/node") as Promise<QwpNodeModule>);
  try {
    qwpNodeModule ??= await loading;
  } catch (error) {
    if (qwpNodeModulePromise === loading) qwpNodeModulePromise = undefined;
    throw error;
  }
}

/** Returns the one QWP Node namespace selected for this root module. */
export function getQwpNodeModule(): QwpNodeModule {
  if (!qwpNodeModule) {
    // Sender's public constructor is synchronous. Async factories preload the
    // matching-format entry above; this fallback retains direct-constructor
    // compatibility and selects the package's CommonJS condition.
    qwpNodeModule = createRequire(import.meta.url)(
      "@questdb/nodejs-client/qwp/node",
    ) as QwpNodeModule;
  }
  return qwpNodeModule;
}
