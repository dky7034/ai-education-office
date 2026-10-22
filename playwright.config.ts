import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.OFFICE_E2E_DB = resolve("database/e2e.sqlite");

export default defineConfig({
  outputDir: "test-results/production",
  testDir: "./tests",
  testIgnore: "**/standalone.spec.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    timezoneId: "Asia/Seoul",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    },
  },
  projects: [
    {
      name: "데스크톱 크로미움",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1536, height: 1100 },
      },
    },
    { name: "모바일 크로미움", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4173",
    env: {
      PORT: "4173",
      OFFICE_DB_PATH: "database/e2e.sqlite",
      OFFICE_INPUT_DIR: "storage/input/e2e",
      OFFICE_OUTPUT_DIR: "storage/output/e2e",
    },
    reuseExistingServer: false,
  },
});
