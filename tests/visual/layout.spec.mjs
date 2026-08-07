import { expect, test } from "./fixtures.mjs";
import { ACCESS_LEVELS } from "../../site/js/policy.js";
import { THEMES } from "../../site/js/theme.js";

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

/**
 * WCAG contrast between two colours, as source to rebuild inside the page.
 *
 * Both colour tests below need it, on opposite sides of the bridge: one reads
 * colours off rendered elements, the other off the token declarations. It has
 * to cross as a string because `page.evaluate` serialises the function it is
 * handed and cannot close over a helper — and it is one self-contained
 * expression, rather than statements, because the receiving side rebuilds it
 * with `new Function`, which `const` declarations would scope away.
 *
 * Accepts both notations: getComputedStyle resolves a rendered colour to
 * `rgb(…)`, but returns a custom property's declaration verbatim, so a token
 * arrives as the `#rrggbb` it was written as.
 */
const CONTRAST_SOURCE = `function (x, y) {
    const channel = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (colour) => {
        const text = colour.trim();
        const parts = text.startsWith("#")
            ? text.slice(1).match(/../g).map((h) => parseInt(h, 16))
            : text.match(/[\\d.]+/g).map(Number);
        const [r, g, b] = parts.slice(0, 3).map(channel);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [luminance(x), luminance(y)];
    return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
}`;

test("access-level badges clear WCAG AA against their text, in every theme", async ({ page }) => {
    // The badge colours are hand-picked hex values. Nothing else stops a future
    // tweak from landing an unreadable one.
    //
    // glue, not a more obvious service, because it is the only one whose actions
    // carry all six levels -- browsing anything else renders a subset and leaves
    // the rest of the palette unmeasured. The completeness check below fails if
    // that ever stops being true.
    //
    // The six levels are deliberately theme-independent, so this loop should
    // measure the same numbers six times over. That is the point: it is what
    // fails the day someone moves them into the theme blocks and retunes one.
    await page.goto("/");
    await pickService(page, "#browse-service", "glue");
    await expect(page.locator("#browse-actions tbody tr").first()).toBeVisible();

    for (const { id } of THEMES) {
        const ratios = await page.evaluate(
            ([theme, source]) => {
                document.documentElement.setAttribute("data-theme", theme);
                const contrast = new Function(`return ${source}`)();

                const seen = new Map();
                for (const badge of document.querySelectorAll(".access-level")) {
                    const style = getComputedStyle(badge);
                    seen.set(
                        badge.textContent.trim(),
                        contrast(style.backgroundColor, style.color),
                    );
                }
                return [...seen.entries()];
            },
            [id, CONTRAST_SOURCE],
        );

        expect(new Set(ratios.map(([level]) => level)), `levels rendered in ${id}`)
            .toEqual(new Set(ACCESS_LEVELS));

        for (const [level, ratio] of ratios) {
            expect(ratio, `${id}: ${level} badge contrast ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
        }
    }
});

test("every theme is declared, distinct, and legible on its own ground", async ({ page }) => {
    // Three failures in one sweep, all of them silent in a browser:
    //
    //   1. theme.js offers an id app.css never declares. The picker looks fine
    //      and the page falls back to Slate Dark, so the theme simply does
    //      nothing -- and the `:root` fallback is what hides it.
    //   2. Two themes resolve to the same ground, meaning one block's selector
    //      is misspelled and is not matching at all.
    //   3. A palette lands a colour that cannot be made out on its own surface.
    //      Checked against the tokens rather than rendered elements because the
    //      contract is the token pair: --br-dim has to work on --br-panel
    //      whether or not anything happens to be painting that combination today.
    //
    // The two thresholds are WCAG's own. Text needs 4.5:1; a graphical object
    // needs 3:1, which is what --br-info gets, since a finding's 3px stripe is
    // the only thing it paints. --br-accent stays in the text group despite also
    // being a stripe -- .scope-required sets it as type, so the stricter number
    // is the one that binds.
    await page.goto("/");

    const TEXT = ["--br-ink", "--br-dim", "--br-accent", "--br-danger"];
    const GRAPHICAL = ["--br-info"];

    const measured = [];
    for (const { id } of THEMES) {
        measured.push(
            await page.evaluate(
                ([theme, source, text, graphical]) => {
                    document.documentElement.setAttribute("data-theme", theme);
                    const contrast = new Function(`return ${source}`)();

                    const style = getComputedStyle(document.documentElement);
                    const token = (name) => style.getPropertyValue(name).trim();
                    const [bg, panel] = [token("--br-bg"), token("--br-panel")];

                    const against = (names, floor) =>
                        names.flatMap((name) => [
                            [`${name} on --br-bg`, contrast(token(name), bg), floor],
                            [`${name} on --br-panel`, contrast(token(name), panel), floor],
                        ]);

                    return {
                        theme,
                        bg,
                        pairs: [...against(text, 4.5), ...against(graphical, 3)],
                    };
                },
                [id, CONTRAST_SOURCE, TEXT, GRAPHICAL],
            ),
        );
    }

    for (const { theme, bg, pairs } of measured) {
        expect(bg, `${theme} declares --br-bg`).toMatch(/^#[0-9a-f]{6}$/i);
        for (const [pair, ratio, floor] of pairs) {
            expect(ratio, `${theme}: ${pair} is ${ratio}:1, needs ${floor}:1`)
                .toBeGreaterThanOrEqual(floor);
        }
    }

    expect(new Set(measured.map((m) => m.bg)).size, "each theme has its own ground")
        .toBe(THEMES.length);
});

test("the picker applies a theme and remembers it across a reload", async ({ page }) => {
    await page.goto("/");

    const root = page.locator("html");
    await page.locator("#theme-family").selectOption("carbon");
    await page.locator("#theme-mode").selectOption("light");
    await expect(root).toHaveAttribute("data-theme", "carbon-light");
    await expect(root).toHaveAttribute("data-bs-theme", "light");

    await page.reload();

    // The assertion the pre-paint script exists for: without it the module would
    // land this attribute only after the first paint, and the reload would flash
    // the dark ground before turning white.
    await expect(root).toHaveAttribute("data-theme", "carbon-light");
    await expect(page.locator("#theme-family")).toHaveValue("carbon");
    await expect(page.locator("#theme-mode")).toHaveValue("light");
});

test("following the OS keeps the chosen palette", async ({ page }) => {
    // The point of splitting the picker in two, and the one part jsdom cannot
    // reach — it has no media queries, so the unit suite stubs a fixed answer.
    // Here the scheme is real and can be changed underneath a loaded page.
    await page.goto("/");
    await page.locator("#theme-family").selectOption("parchment");

    const root = page.locator("html");

    // The suite runs dark (see playwright.config.mjs), so Parchment on System
    // starts dark.
    await expect(root).toHaveAttribute("data-theme", "parchment-dark");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(root).toHaveAttribute("data-theme", "parchment-light");
    await expect(root).toHaveAttribute("data-bs-theme", "light");
    await expect(page.locator("#theme-family")).toHaveValue("parchment");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(root).toHaveAttribute("data-theme", "parchment-dark");

    // And the same across a reload, which is the pre-paint script's copy of the
    // rule rather than the module's.
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(root).toHaveAttribute("data-theme", "parchment-light");
});

test("a preference from the single-select picker still resolves", async ({ page }) => {
    // "system" is what it wrote for "follow the OS". Read as a `<family>-<mode>`
    // preference it parses as nothing, so without the migration a returning
    // visitor on a light desktop would be pinned to dark — in both the module
    // and the pre-paint script, which carry the rule separately.
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("apva.theme", "system"));

    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "slate-light");
    await expect(page.locator("#theme-mode")).toHaveValue("system");
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

    // Hooked on .stmt-count, not a generic `.badge`: the access-level filters
    // below it are badges too, so `.badge` first only ever worked by DOM order.
    const badge = page.locator("#gen-statements .stmt-count").first();
    await expect(badge).toHaveText("0 selected");

    await page.locator(".action-picker .form-check-input").first().check();
    await expect(badge).toHaveText("1 selected");

    await page.locator(".action-picker .form-check-input").nth(1).check();
    await expect(badge).toHaveText("2 selected");

    await page.locator(".action-picker .form-check-input").first().uncheck();
    await expect(badge).toHaveText("1 selected");
});
