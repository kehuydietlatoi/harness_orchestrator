import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Default (`npm test`) config: the mocked unit suite. The subprocess e2e suite
// has its own config (vitest.e2e.config.ts) and is excluded here so a plain
// `vitest run` stays fast and deterministic.
export default defineConfig({
  test: {
    // Per-user state (telemetry, harness availability) must never touch the real ~/.orch.
    env: { ORCH_HOME: mkdtempSync(join(tmpdir(), "orch-home-")) },
    // Several suites run real git and subprocesses. The 5s default is plenty locally but not on a loaded Windows
    // runner (a `commandExists` check and a repair test each timed out there while passing on re-run), where a
    // timeout is a flake, not a finding. A genuinely hung test still fails, just later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
        statements: 72,
        branches: 85,
        functions: 77,
        lines: 72,
      },
    },
  },
});
