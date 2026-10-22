import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { resolve } from "node:path";
process.env.OFFICE_E2E_DB = resolve("database/e2e-dev.sqlite");

export default defineConfig({
  ...base,
  outputDir: "test-results/development",
  testMatch:
    /(?:jobs|auth|attachments|preview|summary|server-office)\.spec\.ts/,
  testIgnore: [],
  use: { ...base.use, baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173/api/health",
    env: {
      PORT: "3001",
      OFFICE_DB_PATH: "database/e2e-dev.sqlite",
      OFFICE_INPUT_DIR: "storage/input/e2e-dev",
      OFFICE_OUTPUT_DIR: "storage/output/e2e-dev",
    },
    reuseExistingServer: false,
  },
});
