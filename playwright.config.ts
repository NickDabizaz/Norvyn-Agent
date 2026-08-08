import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  reporter: "line",
  outputDir: ".tmp/playwright-results",
  preserveOutput: "failures-only",
  use: {
    baseURL: "http://127.0.0.1:4178",
    browserName: "chromium",
    viewport: { width: 1024, height: 768 },
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  webServer: {
    command: "npm run build && tsx test/browser/harness.ts",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
