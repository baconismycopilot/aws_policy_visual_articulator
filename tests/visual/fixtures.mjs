/**
 * Serves the page's CDN subresources from node_modules instead of the network.
 *
 * site/index.html pulls Bootstrap from cdn.jsdelivr.net. That is fine for the
 * deployed page but wrong for a required PR gate: a slow or unreachable CDN
 * does not fail `page.goto` — `load` fires even when a subresource never
 * arrives — so the run dies 30s later on an unrelated click, with nothing
 * pointing at the network as the cause. Routing the request to the copy npm
 * already installed makes the suite self-contained and offline-clean.
 *
 * The local bytes are the published package's, so the integrity attributes in
 * index.html still verify. If they ever stop matching, the browser drops the
 * stylesheet and the layout assertions fail — hence the explicit version check
 * below, which says so plainly rather than leaving a mystery.
 */

import { test as base, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fromRoot = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** "/npm/bootstrap@5.3.6/dist/css/x.css" -> ["bootstrap", "5.3.6", "dist/css/x.css"]. */
const CDN_PATH = /^\/npm\/(@?[^@/]+(?:\/[^@/]+)?)@([^/]+)\/(.+)$/;

function resolve(url) {
    const match = new URL(url).pathname.match(CDN_PATH);
    if (!match) throw new Error(`unroutable CDN request: ${url}`);

    const [, pkg, wanted, file] = match;
    const meta = JSON.parse(readFileSync(fromRoot(`node_modules/${pkg}/package.json`), "utf8"));
    if (meta.version !== wanted) {
        throw new Error(
            `site/index.html pins ${pkg}@${wanted} but node_modules has ${meta.version}. ` +
                `The integrity hash would not match — pin the same version in package.json.`,
        );
    }
    return fromRoot(`node_modules/${pkg}/${file}`);
}

export const test = base.extend({
    page: async ({ page }, use) => {
        await page.route("https://cdn.jsdelivr.net/**", (route) =>
            route.fulfill({ path: resolve(route.request().url()) }),
        );
        await use(page);
    },
});

export { expect };
