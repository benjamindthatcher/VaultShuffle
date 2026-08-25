import { defineConfig, devices } from "@playwright/test";

/**
 * Three end-to-end tests, deliberately.
 *
 * Unit tests cover the scoring, the recency model and the filters; the build
 * covers types. What none of them can catch is the app rendering a page that
 * cannot actually produce a recommendation - which is the one thing VaultShuffle
 * exists to do, and the thing most at risk during a run of rapid UI changes.
 *
 * They run against a production build so what is tested is what ships.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:8799",
    trace: "on-first-retry"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npx next start -p 8799",
    url: "http://127.0.0.1:8799",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000
  }
});
