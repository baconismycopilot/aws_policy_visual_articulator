"use strict";

/**
 * Entry point: wires the shared account context and boots both tabs.
 */

import { loadGlobal } from "./data.js";
import { initBrowse, refreshBrowse } from "./browse.js";
import { initGenerate, refreshGenerate } from "./generate.js";
import { el, option, render } from "./dom.js";

const STORAGE_KEY = "apva.context";

/** Shared by the ARN builders in both tabs. */
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

function wireContextBar(globalData) {
    const partition = document.getElementById("ctx-partition");
    const region = document.getElementById("ctx-region");
    const account = document.getElementById("ctx-account");

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
        saveContext();
        refreshBrowse();
        refreshGenerate();
    };

    partition.addEventListener("change", onChange);
    region.addEventListener("input", onChange);
    account.addEventListener("input", onChange);
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
    loadContext();

    try {
        const globalData = await loadGlobal();
        wireContextBar(globalData);

        document.getElementById("footer-generated").textContent =
            `Data generated ${globalData.generated_at}.`;

        await Promise.all([initBrowse(context), initGenerate(context)]);
    } catch (error) {
        console.error(error);
        showFatal(error);
    }
}

main();
