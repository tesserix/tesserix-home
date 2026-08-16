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
 */
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
  webServer: {
    // The bypass is what makes these tests possible: middleware returns early
    // before reading a session, so no Zitadel round trip is needed. It throws
    // at startup under NODE_ENV=production (middleware.ts), so it cannot leak
    // into a real deployment.
    command: "npm run dev",
    env: { NEXT_PUBLIC_DEV_AUTH_BYPASS: "true" },
    url: "http://localhost:3003",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
