import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests (Vitest) are separate from the Playwright E2E suite in tests/.
// We only pick up co-located *.test.ts under lib/ so Playwright's tests/*.spec.ts
// are never run by Vitest.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    exclude: ["node_modules", ".next", "tests"],
  },
});
