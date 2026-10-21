import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  outputDir: "test-results/standalone",
  testMatch: "**/standalone.spec.ts",
  testIgnore: [],
  webServer: undefined,
});
