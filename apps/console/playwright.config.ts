import { defineConfig, devices } from "@playwright/test";

/**
 * Browser coverage for the console.
 *
 * Deliberately narrow: these tests exist for the failures unit tests cannot
 * see — real layout, real CSS, the real bundle. Anything assertable in jsdom
 * belongs in the vitest suite, where it runs in milliseconds.
 *
 * Chromium only. This is an internal console used in one browser; five
 * projects would cost five times as much and tell us the same thing.
 *
 * # Why there are now two servers and a database (#271)
 *
 * This suite used to run with `TESSERIX_DB_*` unset and no stand-in for
 * apps/web, so EVERY CRM surface rendered its error state by design and the
 * admin-backed surfaces rendered nothing at all. It passed 17/17 and proved
 * only that the console fails gracefully — #243 was filed because no test
 * opened a detail page, and #245 (a live drift-clock bug) had to be proved
 * with pglite integration tests because e2e could not reach the behaviour.
 *
 * So the suite now runs against a seeded Postgres and the local admin-API
 * stub, and asserts what surfaces SHOW. The error-state tests are kept —
 * graceful failure is still a requirement — but they no longer stand in for
 * coverage of the working path.
 */

// Defaults match docker-compose.dev.yml and .env.development. CI overrides
// them for its own service container.
const DB_ENV = {
  TESSERIX_DB_HOST: process.env.TESSERIX_DB_HOST ?? "localhost",
  TESSERIX_DB_PORT: process.env.TESSERIX_DB_PORT ?? "55432",
  TESSERIX_DB_NAME: process.env.TESSERIX_DB_NAME ?? "tesserix_admin",
  TESSERIX_DB_USER: process.env.TESSERIX_DB_USER ?? "tesserix",
  TESSERIX_DB_PASSWORD: process.env.TESSERIX_DB_PASSWORD ?? "tesserix",
  // A plain Postgres refuses the TLS negotiation the cluster requires.
  TESSERIX_DB_SSLMODE: process.env.TESSERIX_DB_SSLMODE ?? "disable",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "line" : "html",
  use: {
    baseURL: "http://localhost:3003",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The admin-API stub, standing in for apps/web. Started FIRST — the
      // console reads it during server rendering, so a console that boots
      // without it renders the surfaces this suite is here to assert.
      command: "node dev/admin-stub.mjs",
      url: "http://localhost:3002/api/admin/dashboard",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // The bypass is what makes these tests possible: middleware returns early
      // before reading a session, so no Zitadel round trip is needed. It throws
      // at startup under NODE_ENV=production (middleware.ts), so it cannot leak
      // into a real deployment.
      command: "npm run dev",
      env: {
        NEXT_PUBLIC_DEV_AUTH_BYPASS: "true",
        WEB_INTERNAL_ORIGIN: "http://localhost:3002",
        ...DB_ENV,
      },
      url: "http://localhost:3003",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
