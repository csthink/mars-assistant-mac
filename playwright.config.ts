import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/desktop",
  // Background desktop tests run in four worker processes: every test launches its own client on its
  // own data root, and a test file runs in one worker from start to end (fullyParallel stays off).
  // Integration, native and real-provider tests stay serial through their project limits.
  workers: 4,
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
    { name: "integration", testMatch: "*.integration.ts", workers: 1 },
    { name: "native", testMatch: "*.native.ts", workers: 1 },
    { name: "real", testMatch: "real-*.spec.ts", workers: 1 },
  ],
});
