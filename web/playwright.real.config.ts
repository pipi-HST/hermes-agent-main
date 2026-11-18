import { defineConfig, devices } from "playwright/test";

const baseURL = process.env.HERMES_REAL_E2E_BASE_URL;
const isWindows = process.platform === "win32";
const configuredChannel = process.env.HERMES_PLAYWRIGHT_CHANNEL?.trim();
const channel =
  configuredChannel === "bundled"
    ? undefined
    : configuredChannel || (isWindows ? "chrome" : undefined);

if (!baseURL) {
  throw new Error("HERMES_REAL_E2E_BASE_URL is required for real knowledge E2E");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-real", open: "never" }]],
  outputDir: "test-results-real",
  use: {
    baseURL,
    headless: true,
    // Windows test processes use the locally installed Chrome (the bundled
    // Chromium download is not guaranteed to be present). Linux CI keeps the
    // bundled Chromium installed by `playwright install chromium`. Override
    // with HERMES_PLAYWRIGHT_CHANNEL=<channel>; use "bundled" to force the
    // bundled browser.
    ...(channel ? { channel } : {}),
    launchOptions: {
      // Chromium's crashpad handler can kill the Windows test process.
      args: [
        "--disable-crash-reporter",
        "--disable-breakpad",
        ...(isWindows ? ["--no-sandbox", "--disable-gpu"] : []),
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Video needs the ffmpeg helper, which is not part of this test setup.
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
