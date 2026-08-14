import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests (Vitest) are separate from any future Playwright E2E suite.
//
// Two projects rather than one: the pure-function tests stay in a plain node
// environment (fast, and it keeps proving those functions are extractable),
// while the kit's render/interaction tests need a DOM. The split is by file
// extension — `*.test.ts` is node, `*.test.tsx` is jsdom — so neither suite
// can accidentally acquire the other's environment.
const SHARED = {
  // @tesserix/web's ESM barrel re-exports via bare directory specifiers,
  // which Node's ESM resolver rejects when a dependency is externalised.
  // Inlining routes it through Vite's resolver instead, so kit modules that
  // import the design system are importable from a plain node-env test.
  server: { deps: { inline: ["@tesserix/web"] } },
  exclude: ["node_modules", ".next", "tests"],
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          ...SHARED,
          name: "node",
          environment: "node",
          include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.ts"],
        },
      },
      {
        plugins: [tsconfigPaths()],
        // tsconfig keeps `jsx: "preserve"` for Next's own compiler, so Vitest
        // is told explicitly how to transform JSX.
        esbuild: { jsx: "automatic", jsxImportSource: "react" },
        // A second physical copy of react means Testing Library's `act()`
        // flushes a queue the rendered component is not on, and every
        // `render()` silently returns an empty container. The root
        // package.json pins react/react-dom to the one version every app
        // declares; this is the belt to those braces.
        resolve: { dedupe: ["react", "react-dom"] },
        test: {
          ...SHARED,
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["lib/**/*.test.tsx", "app/**/*.test.tsx", "components/**/*.test.tsx"],
        },
      },
    ],
  },
});
