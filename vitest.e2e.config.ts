import { defineConfig } from "vitest/config";

// End-to-end smoke tests run the *built* CLI as a real subprocess, so they need
// longer timeouts than the mocked unit suite and a separate include glob. They
// are excluded from the default `npm test` (which only matches *.test.ts).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
