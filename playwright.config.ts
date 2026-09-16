import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Local runs default to PGlite; CI supplies its isolated Postgres database.
  // E2E_BASE_URL uses an already running production server.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm start",
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          PGLITE_DIR: process.env.PGLITE_DIR ?? "./data/pglite-e2e",
          SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-session-secret-not-for-production",
          CRON_SECRET: process.env.CRON_SECRET ?? "e2e-cron-secret",
          APP_URL: process.env.APP_URL ?? baseURL,
          DEMO_ENABLED: "1",
        },
      },
  projects: [
    { name: "organiser", use: { ...devices["Desktop Chrome"] } },
    {
      name: "judge",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
