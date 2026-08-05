/**
 * A DOM for the render modules, without a browser.
 *
 * The page's own index.html supplies the markup, so these tests break if an
 * element id the modules depend on is renamed — which a hand-written fixture
 * would not catch.
 *
 * Three things jsdom does not implement have to be stubbed. Each is inert in
 * the code under test, so stubbing them changes no behaviour being asserted:
 *
 *   fetch                  the modules request "./data/…"; served from disk
 *   scrollIntoView         combobox keyboard navigation calls it
 *   navigator.clipboard    the Copy JSON button
 *   URL.createObjectURL    the Download button
 */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const ROOT = new URL("../site/", import.meta.url);

/**
 * Build a live document from site/index.html with the data directory wired to
 * the real generated shards.
 *
 * @returns {{dom: JSDOM, window: Window, document: Document, cleanup: () => void}}
 */
export function setupPage() {
    const html = readFileSync(new URL("index.html", ROOT), "utf8");

    const dom = new JSDOM(html, {
        url: "http://localhost/",
        pretendToBeVisual: true,
    });

    const { window } = dom;

    window.fetch = async (path) => {
        const file = new URL(String(path).replace(/^\.\//, ""), ROOT);
        try {
            const body = readFileSync(file, "utf8");
            return {
                ok: true,
                status: 200,
                json: async () => JSON.parse(body),
            };
        } catch {
            return { ok: false, status: 404, json: async () => ({}) };
        }
    };

    window.Element.prototype.scrollIntoView = () => {};

    let copied = null;
    Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => { copied = text; } },
    });
    window.__copied = () => copied;

    window.URL.createObjectURL = () => "blob:stub";
    window.URL.revokeObjectURL = () => {};

    // The modules reach for these as globals.
    const globals = ["document", "window", "fetch", "navigator", "Element", "Blob", "localStorage"];
    const saved = new Map();
    for (const name of globals) {
        // Read the descriptor rather than the value: touching Node's own
        // globalThis.localStorage getter emits an ExperimentalWarning.
        saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: true,
            value: name === "window" ? window : window[name],
        });
    }

    return {
        dom,
        window,
        document: window.document,
        cleanup() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
            dom.window.close();
        },
    };
}

/** Fire an `input` event the way a user typing would. */
export function type(element, value) {
    element.value = value;
    element.dispatchEvent(new element.ownerDocument.defaultView.Event("input", { bubbles: true }));
}

/** Fire a `change` event, for checkboxes, radios and selects. */
export function change(element) {
    element.dispatchEvent(new element.ownerDocument.defaultView.Event("change", { bubbles: true }));
}

/** Click, via the real event path so delegated handlers see it. */
export function click(element) {
    element.dispatchEvent(
        new element.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }),
    );
}

/** The combobox commits on mousedown, before blur can steal the click. */
export function mousedown(element) {
    element.dispatchEvent(
        new element.ownerDocument.defaultView.MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
        }),
    );
}

/** Let queued microtasks — the modules' awaited fetches — settle. */
export function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** First element matching a selector whose text contains `text`. */
export function byText(root, selector, text) {
    return [...root.querySelectorAll(selector)].find((el) =>
        el.textContent.includes(text),
    );
}
