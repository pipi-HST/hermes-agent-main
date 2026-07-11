import { defineConfig, devices } from "playwright/test";

const baseURL = process.env.HERMES_REAL_E2E_BASE_URL;

if (!baseURL) {
  throw new Error("HERMES_REAL_E2E_BASE_URL is required for real knowledge E2E");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-real", open: "never" }]],
  outputDir: "test-results-real",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
