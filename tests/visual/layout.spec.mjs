import { expect, test } from "./fixtures.mjs";
import { ACCESS_LEVELS } from "../../site/js/policy.js";

/**
 * Layout and colour, in a real browser.
 *
 * These assert geometry and computed style rather than comparing screenshots.
 * Pixel baselines drift with the platform's font rendering — a baseline shot on
 * macOS fails on a Linux runner for reasons that have nothing to do with the
 * change under review. Asserting "nothing overflows the viewport" and "this
 * contrast ratio clears AA" holds everywhere and says what actually matters.
 *
 * Screenshots are still captured, but as artifacts for a human to glance at,
 * never as a pass/fail gate.
 */

/** Select a service in whichever tab's combobox is passed. */
async function pickService(page, mount, query) {
    await page.locator(`${mount} input`).fill(query);
    const option = page.locator(`${mount} .combobox-option`).first();
    await expect(option).toBeVisible();
    await option.click();
}

/** Build a scoped statement on the Generate tab — the densest layout we have. */
async function buildStatement(page) {
    await page.getByRole("tab", { name: "Generate" }).click();
    await pickService(page, "#gen-statements .combobox", "eks");
    await page.locator(".action-picker .form-check-input").first().check();
    await page.getByText("Specific ARNs").click();
    await expect(page.locator(".arn-preview").first()).toBeVisible();
}

/**
 * Elements extending past the right edge of the viewport.
 *
 * Ignores anything inside a container that is *meant* to scroll sideways —
 * `.table-responsive` and `.policy-output` both do, deliberately.
 */
async function overflowing(page) {
    return page.evaluate((width) => {
        const scrollers = [...document.querySelectorAll(".table-responsive, .policy-output, .action-picker")];
        return [...document.querySelectorAll("body *")]
            .filter((el) => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.right <= width + 1) return false;
                return !scrollers.some((s) => s.contains(el));
            })
            .map((el) => `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} class="${el.className}">`)
            .slice(0, 5);
    }, page.viewportSize().width);
}

test("the page never scrolls sideways on load", async ({ page }) => {
    await page.goto("/");
    const width = page.viewportSize().width;

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await overflowing(page)).toEqual([]);
});

test("the page never scrolls sideways with a full action table", async ({ page }) => {
    await page.goto("/");
    await pickService(page, "#browse-service", "eks");
    await expect(page.locator("#browse-actions tbody tr").first()).toBeVisible();

    // The table itself scrolls inside .table-responsive; the page must not.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize().width,
    );
    expect(await overflowing(page)).toEqual([]);
});

test("the page never scrolls sideways while building a policy", async ({ page }) => {
    // Regression: the statement card header did not wrap, so the Remove button
    // pushed 51px past the right edge of a phone viewport.
    await page.goto("/");
    await buildStatement(page);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize().width,
    );
    expect(await overflowing(page)).toEqual([]);
});

test("the combobox dropdown opens fully inside the viewport", async ({ page }) => {
    await page.goto("/");
    await page.locator("#browse-service input").fill("e");

    const list = page.locator("#browse-service .combobox-list");
    await expect(list).toBeVisible();

    const box = await list.boundingBox();
    const { width, height } = page.viewportSize();

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
});

test("the dropdown paints above the content beneath it", async ({ page }) => {
    // A z-index regression would leave table rows showing through the list.
    await page.goto("/");
    await pickService(page, "#browse-service", "eks");
    await expect(page.locator("#browse-actions tbody tr").first()).toBeVisible();

    await page.locator("#browse-service input").click();
    const list = page.locator("#browse-service .combobox-list");
    await expect(list).toBeVisible();

    // Probe the list's own centre. Hit-testing a specific option is unreliable:
    // reopening scrolls the selected one into view, which can push the first
    // option outside the viewport entirely. Measuring and probing in one
    // in-browser step also keeps the coordinates from going stale.
    const topmost = await list.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
        );
        if (!hit) return "nothing at that point";
        return hit.closest(".combobox-list") ? "dropdown" : hit.tagName.toLowerCase();
    });

    expect(topmost).toBe("dropdown");
});

test("access-level badges clear WCAG AA against their text", async ({ page }) => {
    // The badge colours are hand-picked hex values. Nothing else stops a future
    // tweak from landing an unreadable one.
    //
    // glue, not a more obvious service, because it is the only one whose actions
    // carry all six levels -- browsing anything else renders a subset and leaves
    // the rest of the palette unmeasured. The completeness check below fails if
    // that ever stops being true.
    await page.goto("/");
    await pickService(page, "#browse-service", "glue");
    await expect(page.locator("#browse-actions tbody tr").first()).toBeVisible();

    const ratios = await page.evaluate(() => {
        const channel = (v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (rgb) => {
            const [r, g, b] = rgb.match(/\d+/g).map(Number).map(channel);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };

        const seen = new Map();
        for (const badge of document.querySelectorAll(".access-level")) {
            const style = getComputedStyle(badge);
            const [a, b] = [luminance(style.backgroundColor), luminance(style.color)];
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            seen.set(badge.textContent.trim(), Number(ratio.toFixed(2)));
        }
        return [...seen.entries()];
    });

    expect(new Set(ratios.map(([level]) => level))).toEqual(new Set(ACCESS_LEVELS));
    for (const [level, ratio] of ratios) {
        expect(ratio, `${level} badge contrast ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
    }
});

test("action links are distinguishable from plain table text", async ({ page }) => {
    // They are deliberately not link-blue; the underline is what marks them.
    await page.goto("/");
    await pickService(page, "#browse-service", "eks");

    const link = page.locator("#browse-actions a.action-link").first();
    await expect(link).toBeVisible();

    const style = await link.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bottom: s.borderBottomStyle, width: s.borderBottomWidth };
    });

    expect(style.bottom).toBe("dotted");
    expect(parseFloat(style.width)).toBeGreaterThan(0);
});

test("the selection count tracks the checkboxes", async ({ page }) => {
    // Regression: the badge was rendered once and never updated, so it read
    // "0 selected" with actions visibly checked. Caught by a screenshot.
    await page.goto("/");
    await page.getByRole("tab", { name: "Generate" }).click();
    await pickService(page, "#gen-statements .combobox", "eks");

    const badge = page.locator("#gen-statements .badge").first();
    await expect(badge).toHaveText("0 selected");

    await page.locator(".action-picker .form-check-input").first().check();
    await expect(badge).toHaveText("1 selected");

    await page.locator(".action-picker .form-check-input").nth(1).check();
    await expect(badge).toHaveText("2 selected");

    await page.locator(".action-picker .form-check-input").first().uncheck();
    await expect(badge).toHaveText("1 selected");
});
