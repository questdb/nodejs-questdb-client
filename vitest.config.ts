import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep `pnpm test` fast: unit tests and the benchmark validation
    // assertions, but never the benchmarks themselves.
    include: ["test/**/*.test.ts", "benchmarks/**/*.test.ts"],
    // `benchmark` nests UNDER `test` — a top-level key is silently ignored
    // and `vitest bench` then picks up its default globs instead.
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
  },
});
