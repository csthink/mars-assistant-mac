import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/desktop",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: process.env.CSTHINK_TEST_OUTPUT_DIR ?? "test-results/artifacts",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.CSTHINK_TEST_REPORT ?? "test-results/results.json",
      },
    ],
  ],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", testMatch: "*.spec.ts", testIgnore: "real-*.spec.ts" },
    { name: "integration", testMatch: "*.integration.ts" },
    { name: "native", testMatch: "*.native.ts" },
    { name: "real", testMatch: "real-*.spec.ts" },
  ],
});
