import { test } from "@playwright/test";

/**
 * Captures the main views as CI artifacts.
 *
 * Deliberately not `toHaveScreenshot()`. Pixel baselines drift with the
 * platform's font rendering, so a baseline taken on macOS fails on a Linux
 * runner for reasons unrelated to the change under review — the failure mode is
 * noise, and noisy gates get ignored. These are for a human to glance at when
 * something looks off; layout.spec.mjs holds the assertions that actually gate.
 */

const shot = (testInfo, name) =>
    testInfo.outputPath(`${name}-${testInfo.project.name}.png`);

/**
 * Bootstrap fades tab panes in, and a shot taken mid-transition comes out
 * dimmed. Playwright's `animations: "disabled"` is worse here — it freezes the
 * fade at opacity 0 and the pane captures blank — so wait it out instead.
 */
async function settleTab(page) {
    await page.waitForFunction(() => {
        const pane = document.querySelector(".tab-pane.active");
        return pane && getComputedStyle(pane).opacity === "1";
    });
}

async function pickService(page, mount, query) {
    await page.locator(`${mount} input`).fill(query);
    await page.locator(`${mount} .combobox-option`).first().click();
}

test("capture: browse", async ({ page }, testInfo) => {
    await page.goto("/");
    await settleTab(page);
    await page.screenshot({ path: shot(testInfo, "01-empty") });

    await page.locator("#browse-service input").fill("kube");
    await page.screenshot({ path: shot(testInfo, "02-combobox-open") });

    await page.locator("#browse-service .combobox-option").first().click();
    await page.locator("#browse-actions tbody tr").first().waitFor();
    await page.screenshot({ path: shot(testInfo, "03-actions"), fullPage: true });
});

test("capture: generate", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Generate" }).click();
    await settleTab(page);
    await pickService(page, "#gen-statements .combobox", "eks");

    // Mix a scopeable action with a wildcard-only one, so the shot shows the
    // split and the findings that explain it.
    for (const name of ["CreateAddon", "CreateCluster"]) {
        await page.locator(`.action-picker input[id*="-${name}-"]`).first().check();
    }
    await page.getByText("Specific ARNs").click();
    await page.locator(".arn-preview").first().waitFor();

    await page.screenshot({ path: shot(testInfo, "04-generate-split"), fullPage: true });
});
