import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/qwp/dist.e2e.ts"],
    // The suite loads the built bundles directly; Vite must not pre-bundle or
    // otherwise rewrite them, or the per-entry-point module identity this
    // suite exists to check would be lost.
    server: { deps: { external: [/dist[\\/]/] } },
  },
});
