import { defineConfig, devices } from "@playwright/test";

/**
 * Visual and layout coverage. jsdom does no layout, so anything that depends
 * on real geometry — clipping, overflow, sticky positioning, computed colour —
 * can only be checked here.
 *
 * Specs live in tests/visual/ so `node --test tests/*.test.mjs` does not try
 * to run them.
 */
// tests/visual/server.mjs honours PORT, so the URLs below have to read the
// same value — otherwise an exported PORT (the Makefile advertises one) binds
// the server elsewhere and Playwright waits out its 60s timeout on 8081.
const PORT = Number(process.env.PORT || 8081);
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: "./tests/visual",
    testMatch: "**/*.spec.mjs",
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

    use: {
        baseURL: ORIGIN,
        trace: "on-first-retry",
        screenshot: "only-on-failure",

        // The page's default theme follows the OS, so without this the whole
        // suite would render in whatever colour scheme the browser happens to
        // report -- and the captured screenshots would silently change meaning.
        // Pinned to dark, the palette the page has always shipped; the theme
        // tests in layout.spec.mjs cycle all six explicitly.
        colorScheme: "dark",
    },

    projects: [
        { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
        { name: "mobile", use: { ...devices["Pixel 7"] } },
    ],

    webServer: {
        command: "node tests/visual/server.mjs",
        url: ORIGIN,
        reuseExistingServer: !process.env.CI,
        stdout: "ignore",
    },
});
