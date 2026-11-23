/* global process */
import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "E2E_BACKEND_PORT=8010 bash ../scripts/run-e2e-backend.sh",
      url: "http://127.0.0.1:8010/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_SHARED_API_BASE_URL: ".",
        VITE_ENABLE_AI: "false",
        VITE_MAPTILER_KEY: loadEnv("development", process.cwd(), "VITE_MAPTILER_KEY").VITE_MAPTILER_KEY || "local-browser-test",
        VITE_PROXY_TARGET: "http://127.0.0.1:8010",
      },
    },
  ],
});
