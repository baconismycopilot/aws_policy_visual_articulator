import { defineConfig, devices } from "@playwright/test";

/**
 * Visual and layout coverage. jsdom does no layout, so anything that depends
 * on real geometry — clipping, overflow, sticky positioning, computed colour —
 * can only be checked here.
 *
 * Specs live in tests/visual/ so `node --test tests/*.test.mjs` does not try
 * to run them.
 */
export default defineConfig({
    testDir: "./tests/visual",
    testMatch: "**/*.spec.mjs",
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

    use: {
        baseURL: "http://127.0.0.1:8081",
        trace: "on-first-retry",
        screenshot: "only-on-failure",
    },

    projects: [
        { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
        { name: "mobile", use: { ...devices["Pixel 7"] } },
    ],

    webServer: {
        command: "node tests/visual/server.mjs",
        url: "http://127.0.0.1:8081",
        reuseExistingServer: !process.env.CI,
        stdout: "ignore",
    },
});
