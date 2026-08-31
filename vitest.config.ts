import { configDefaults, defineConfig } from "vitest/config";

// Default (`npm test`) config: the mocked unit suite. The subprocess e2e suite
// has its own config (vitest.e2e.config.ts) and is excluded here so a plain
// `vitest run` stays fast and deterministic.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli.ts", // commander wiring; exercised by the e2e smoke, not units
        "src/**/*.d.ts",
      ],
      // A regression ratchet, not a target: set just below the current baseline
      // so coverage can't silently backslide. Raise these as coverage improves.
      // The floor is dragged down by the thin src/commands/* CLI wrappers, which
      // are presentational and covered by the e2e smoke rather than units.
      thresholds: {
        statements: 55,
        branches: 78,
        functions: 55,
        lines: 55,
      },
    },
  },
});
