import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests (Vitest) are separate from any future Playwright E2E suite.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.ts"],
    exclude: ["node_modules", ".next", "tests"],
    // @tesserix/web's ESM barrel re-exports via bare directory specifiers,
    // which Node's ESM resolver rejects when a dependency is externalised.
    // Inlining routes it through Vite's resolver instead, so kit modules that
    // import the design system are importable from a plain node-env test.
    server: { deps: { inline: ["@tesserix/web"] } },
  },
});
