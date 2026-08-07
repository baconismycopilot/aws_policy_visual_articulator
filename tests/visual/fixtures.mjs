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

/* The navbar chip asks GitHub whether CI is green. Left unrouted it would put a
   live network call in a required gate and make the chip's rendered width depend
   on the answer -- "CI" when offline, "CI · passing" when not -- so a width
   assertion would pass or fail on the state of the repo. Pinned to success. */
const CI_RUNS = { workflow_runs: [{ conclusion: "success" }] };

export const test = base.extend({
    page: async ({ page }, use) => {
        await page.route("https://cdn.jsdelivr.net/**", (route) =>
            route.fulfill({ path: resolve(route.request().url()) }),
        );
        await page.route("https://api.github.com/**", (route) =>
            route.fulfill({ json: CI_RUNS }),
        );
        await use(page);
    },
});

export { expect };
