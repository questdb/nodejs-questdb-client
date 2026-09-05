import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/qwp/browser.e2e.ts"],
    // Only a Chromium launch happens in beforeAll now, not a container pull.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
