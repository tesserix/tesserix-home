import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  // Never bundle Next itself. esbuild will happily inline `next/headers` into
  // this package, and the inlined copy is a DIFFERENT module instance from the
  // one Next populates with the request's AsyncLocalStorage context — so
  // `cookies()` throws "called outside a request scope" in every consumer that
  // calls getCurrentSession(). Externalising leaves the import to the host app,
  // which resolves it to the instance that actually has the request.
  external: ["next", /^next\//],
});
