import { join } from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests (Vitest) are separate from any future Playwright E2E suite.
//
// Two projects rather than one: the pure-function tests stay in a plain node
// environment (fast, and it keeps proving those functions are extractable),
// while the kit's render/interaction tests need a DOM. The split is by file
// extension — `*.test.ts` is node, `*.test.tsx` is jsdom — so neither suite
// can accidentally acquire the other's environment.
/**
 * `server-only` guards `lib/db/tesserix.ts` and the two operator-token modules:
 * it makes a `"use client"` component reaching them a build error that names
 * the import chain, rather than `Module not found: Can't resolve 'net'` from
 * inside `pg`.
 *
 * Outside a bundler there is no `react-server` condition, so Node resolves the
 * package's `default` entry — which throws on import by design — and every
 * server module under test fails to load. See `test/server-only-stub.ts` for
 * why this is a stub and not an alias to the package's own `empty.js`. The
 * guard is unaffected in `next build`, which is the only place it has to work.
 */
const SERVER_ONLY_ALIAS = { "server-only": join(import.meta.dirname, "test/server-only-stub.ts") };

/**
 * `@tesserix/console-core` and `@tesserix/platform-auth` both point their
 * `main`/`module` at a `dist/` that is gitignored and regenerated only by an
 * explicit `pnpm -r --filter "./packages/**" build`. Without these aliases the
 * console's unit tests assert against that build artifact rather than the
 * source they sit next to, so a `dist` that lags `src` is invisible until it
 * bites.
 *
 * When it bites, it does not look like a stale build. There is no compile
 * error — the bundle loads fine, it is simply missing whatever was added since
 * it was written, so the symptom is an absent export or an absent map entry:
 * `ROUTES["platform.newSecret"]` came back `undefined` and `consolePath` threw
 * a `TypeError` reading a property of it. And because tsup emits source maps,
 * the stack frame is mapped back onto `packages/console-core/src/routes.ts`,
 * which reads exactly like a module-initialisation bug in source you can see is
 * correct. Two separate investigations chased that ghost — one filed it as an
 * intermittent flake — before anyone rebuilt `dist` and watched it go green.
 * It only ever looked intermittent because different worktrees carried `dist`
 * directories of different ages.
 *
 * CI never sees any of this: `ci.yml` builds the packages before running the
 * tests, so the artifact there is always current and a PR stays green while
 * every local run is red. That asymmetry is the reason the aliases live here
 * and not in the CI workflow — `next build` still has to exercise the real
 * published artifact, so the build step stays exactly as it is.
 *
 * Only these two need it. `@tesserix/web` is a genuine published dependency
 * rather than workspace source (`server.deps.inline` below is what it needs);
 * `@tesserix/crm-country` ships `index.mjs` directly with no build step, so it
 * has no artifact to go stale.
 */
const WORKSPACE_SRC_ALIAS = {
  "@tesserix/console-core": join(import.meta.dirname, "../../packages/console-core/src/index.ts"),
  "@tesserix/platform-auth": join(import.meta.dirname, "../../packages/platform-auth/src/index.ts"),
};

const SHARED = {
  // @tesserix/web's ESM barrel re-exports via bare directory specifiers,
  // which Node's ESM resolver rejects when a dependency is externalised.
  // Inlining routes it through Vite's resolver instead, so kit modules that
  // import the design system are importable from a plain node-env test.
  server: { deps: { inline: ["@tesserix/web"] } },
  exclude: ["node_modules", ".next", "tests"],
  /**
   * Vitest's default is 5000ms, which this suite has outgrown — #544.
   *
   * What is measured: on an unloaded machine a full green run puts p50 at
   * 0.4ms and p99 at 497ms, but 41 of the 4133 tests exceed 500ms and the
   * slowest — `app/auth/callback/route.test.ts`'s token-store case — takes
   * 2011ms. So the default leaves the slowest test 2.5x headroom, against a
   * suite whose wall time has been observed swinging 46s to 132s on one
   * machine. The timeouts are load, not a slow test: there are 41 candidates
   * over 500ms and whichever is running when the machine is busiest is the one
   * that crosses the budget, which is why the victim file differs every run.
   *
   * 15000ms is a judgement informed by that spread, not arithmetic from it —
   * there is no honest formula here. A whole-suite wall-time ratio is not a
   * per-test stretch factor, and the per-test stretch that WAS measured is
   * worse than any ratio would suggest: under 14 busy loops on a 14-core
   * machine `lib/redirect-origin.guard.test.ts`'s filesystem scan went from
   * 587ms to 9818ms on one attempt and 34344ms on the next. No finite timeout
   * survives that, and 15000ms does not pretend to. What it buys is 7.5x the
   * slowest unloaded test instead of 2.5x, which covers ordinary contention
   * while still failing a genuinely hung test — in 15s rather than 5s.
   *
   * A green run pays nothing for this: a timeout budget is only ever spent by
   * a test that fails.
   */
  testTimeout: 15_000,
  /**
   * Restores `globalThis` after every test, so a file that stubs a global and
   * forgets to restore it cannot leak into the next one.
   *
   * Defence against a bug class, and NOT a fix for the cross-test leak #544 and
   * #394 describe — it does not prevent it. That leak is a test abandoned on
   * timeout whose continuation resumes *inside a later test* and calls that
   * test's stub. Restoring globals between tests cannot help, because the
   * continuation runs after the next test has installed its own stub; measured
   * against a reproduction of the real ordering, an `afterEach`-installed
   * poison stub was called zero times.
   *
   * `lib/platform-api.test.ts` carries the mitigation that does work — see the
   * `installFetchStub` comment there.
   */
  unstubGlobals: true,
  /**
   * Restores every mock's original implementation after each test, so a
   * `vi.fn()`'s return value cannot silently carry from one test into the
   * next.
   *
   * This is what makes each test state its own preconditions instead of
   * inheriting the first test's. Before #550, three tests set a mock's
   * resolved value once — two of them by leaving it to an earlier test in the
   * file — and `vi.clearAllMocks()` clears recorded calls but keeps
   * implementations, so nothing caught it. That fragility is invisible until
   * something reorders the file: `.only`, a moved test, or turning this
   * setting on. And it does not read as a test problem when it bites — the
   * wiped mock returns `undefined`, so the failure lands as a `TypeError`
   * inside production code (`authoring-panel.tsx` doing `.then` on nothing).
   *
   * Like `unstubGlobals`, this is defence against a bug class and NOT a fix
   * for the cross-test leak #544 and #394 describe — a continuation resuming
   * inside a later test is unaffected by what happens between tests.
   */
  restoreMocks: true,
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [tsconfigPaths()],
        resolve: { alias: { ...SERVER_ONLY_ALIAS, ...WORKSPACE_SRC_ALIAS } },
        test: {
          ...SHARED,
          name: "node",
          environment: "node",
          // `dev/` holds the local admin-API stub (#271) and the test that
          // verifies it against the console's own parsers. It is node-env like
          // the rest of this project, and it must run in CI: a stub that has
          // drifted from the contract is worse than no stub, because local
          // development and e2e both keep passing against a shape production
          // no longer serves.
          // `scripts/` holds the CronJob entry point (#326 P1a). It is not
          // reachable from any route, so nothing else in this repo would ever
          // notice it breaking: a scheduled job that fails only in production
          // is exactly the shape of thing whose tests have to run in CI.
          include: [
            "lib/**/*.test.ts",
            "app/**/*.test.ts",
            "components/**/*.test.ts",
            "dev/**/*.test.ts",
            "scripts/**/*.test.ts",
            // `middleware.ts` lives at the app root (Next's own convention),
            // outside every glob above. Its test — the machine-auth
            // exemption's coverage — has to be named explicitly rather than
            // moved under `lib/` just to satisfy a glob it does not belong
            // under.
            "middleware.test.ts",
          ],
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
        resolve: {
          dedupe: ["react", "react-dom"],
          alias: { ...SERVER_ONLY_ALIAS, ...WORKSPACE_SRC_ALIAS },
        },
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
