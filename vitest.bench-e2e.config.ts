import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["benchmarks/e2e.ts"],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
  },
});
