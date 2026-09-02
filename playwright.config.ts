import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",

  // The budget is per test, not per assertion.
  timeout: 90_000,
  expect: { timeout: 20_000 },

  // Each test drives its own browser identity, so they cannot share state and
  // there is nothing to serialise. Two workers everywhere: every app instance
  // handshakes with the real sync server, and higher parallelism starves
  // those round-trips into timeouts.
  fullyParallel: true,
  workers: 2,

  // We expect success on the first pass
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "pnpm run app:build && pnpm run app:preview",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
