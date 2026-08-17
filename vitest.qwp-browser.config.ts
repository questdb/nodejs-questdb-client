import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/qwp/browser.e2e.ts"],
    hookTimeout: 300_000,
    testTimeout: 120_000,
  },
});
