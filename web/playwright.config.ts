import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  outputDir: "../.test-tmp/browser-results",
  use: {
    channel: "msedge",
    baseURL: "http://127.0.0.1:18765",
    viewport: { width: 1440, height: 960 },
  },
  webServer: {
    command:
      '".venv-web/Scripts/python.exe" -m uvicorn planner_api.main:app --host 127.0.0.1 --port 18765',
    cwd: resolve(".."),
    url: "http://127.0.0.1:18765/",
    reuseExistingServer: false,
    env: {
      CIVIL_BIM_DB: resolve(
        "../.test-tmp",
        "browser-" + randomUUID() + ".sqlite3",
      ),
    },
  },
});
