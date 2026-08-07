"use strict";

/**
 * Entry point: wires the account context and boots both tabs.
 */

import { loadGlobal, loadManifest } from "./data.js";
import { renderArn } from "./arn.js";
import { initBrowse } from "./browse.js";
import { initGenerate, refreshGenerate } from "./generate.js";
import { initTheme } from "./theme.js";
import { el, option, render } from "./dom.js";

const STORAGE_KEY = "apva.context";

/**
 * Read by the ARN builders on the Generate tab. The Browse tab does not use it
 * -- it shows action names, not ARNs -- which is why the controls live in that
 * pane rather than in the navbar.
 */
const context = {
    partition: "aws",
    region: "us-east-1",
    account: "",
};

function loadContext() {
    try {
        Object.assign(context, JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
    } catch {
        // A malformed entry is not worth surfacing; fall back to the defaults.
    }
}

function saveContext() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
    } catch {
        // Private browsing, quota, etc. The app works fine without persistence.
    }
}

/**
 * The shape of every ARN the three fields feed.
 *
 * A real template run through the real renderer, so the echo cannot drift from
 * the previews inside a statement: an emptied field wildcards to `*` in both,
 * because that is `renderArn`'s documented rule. The two angle-bracketed
 * segments are not `${...}` placeholders, so they pass through untouched —
 * which is what we want, since the context does not supply them.
 */
const CONTEXT_ARN = "arn:${Partition}:⟨service⟩:${Region}:${Account}:⟨resource⟩";

function contextArn() {
    return renderArn(CONTEXT_ARN, context);
}

function wireContextBar(globalData) {
    const partition = document.getElementById("ctx-partition");
    const region = document.getElementById("ctx-region");
    const account = document.getElementById("ctx-account");
    const arn = document.getElementById("ctx-arn");

    render(
        partition,
        ...globalData.partitions.map((p) => option(p, p, p === context.partition)),
    );
    region.value = context.region;
    account.value = context.account;

    const onChange = () => {
        context.partition = partition.value;
        context.region = region.value;
        context.account = account.value;
        arn.textContent = contextArn();
        saveContext();
        refreshGenerate();
    };

    partition.addEventListener("change", onChange);
    region.addEventListener("input", onChange);
    account.addEventListener("input", onChange);

    // The stored context is already in `context`, so the echo has something to
    // show before the first keystroke.
    arn.textContent = contextArn();
}

function showFatal(error) {
    document.querySelector(".tab-content").prepend(
        el("div", { className: "alert alert-danger" }, [
            el("strong", { textContent: "Could not load the IAM dataset. " }),
            el("span", {
                textContent:
                    "Serve this directory over HTTP (`make serve`) — opening " +
                    "index.html from the filesystem blocks the data fetches.",
            }),
            el("div", { className: "small mt-1 font-monospace", textContent: String(error) }),
        ]),
    );
}

async function main() {
    // Outside the try, and before the fetches: the theme has to be right on the
    // error path too, since showFatal renders its alert into this same page.
    initTheme();
    loadContext();

    try {
        const [globalData, manifest] = await Promise.all([loadGlobal(), loadManifest()]);
        wireContextBar(globalData);

        document.getElementById("footer-generated").textContent =
            `${manifest.n_services} services, ${manifest.n_actions} actions, ` +
            `generated ${manifest.generated_at}.`;

        await Promise.all([initBrowse(), initGenerate(context)]);
    } catch (error) {
        console.error(error);
        showFatal(error);
    }
}

main();
