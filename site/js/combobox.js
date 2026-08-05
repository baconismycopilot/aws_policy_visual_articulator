"use strict";

/**
 * A filtering combobox over a fixed list of items.
 *
 * A plain <select> with 453 options is only usable if you already know the
 * service's display name — "Amazon EKS" and "Elastic Kubernetes Service" sort
 * nowhere near each other. This matches on both the label and the IAM prefix,
 * and falls back to subsequence matching so "eks", "kube", and "elastick" all
 * find the same service.
 */

import { el, render } from "./dom.js";

/** Highest score wins; ties break on the shorter label. */
const SCORE = {
    EXACT: 1000,
    PREFIX_EXACT: 900,
    STARTS: 800,
    WORD_START: 600,
    CONTAINS: 400,
    SUBSEQUENCE: 200,
};

/**
 * Rank one item against a lowercased query.
 * @returns {number} score, or 0 for no match
 */
function score(item, needle) {
    const label = item.label.toLowerCase();
    const key = item.key.toLowerCase();

    if (key === needle || label === needle) return SCORE.EXACT;
    if (key.startsWith(needle)) return SCORE.PREFIX_EXACT;
    if (label.startsWith(needle)) return SCORE.STARTS;

    // Start of any word in the label: "kubernetes" matches "Elastic Kubernetes".
    if (new RegExp(`\\b${escapeRegExp(needle)}`).test(label)) return SCORE.WORD_START;
    if (label.includes(needle) || key.includes(needle)) return SCORE.CONTAINS;

    return subsequenceScore(label, needle) || subsequenceScore(key, needle);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Characters in order but not adjacent. Scored by how tightly packed the match
 * is, so "eks" prefers a compact hit over one spread across a long name.
 */
function subsequenceScore(haystack, needle) {
    let index = 0;
    let first = -1;
    let last = 0;

    for (const char of needle) {
        index = haystack.indexOf(char, index);
        if (index === -1) return 0;
        if (first === -1) first = index;
        last = index;
        index += 1;
    }

    const span = last - first + 1;
    return SCORE.SUBSEQUENCE - Math.min(span - needle.length, SCORE.SUBSEQUENCE - 1);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.mount     container to render into
 * @param {Array<{key: string, label: string}>} options.items
 * @param {string} options.placeholder
 * @param {(key: string|null) => void} options.onSelect
 * @param {string|null} [options.value]   initially selected key
 * @param {boolean} [options.disabled]    render read-only, e.g. when a policy
 *                                        type pins the service
 * @returns {{setValue: (key: string|null) => void, focus: () => void}}
 */
export function combobox({
    mount,
    items,
    placeholder = "Search…",
    onSelect,
    value = null,
    disabled = false,
}) {
    let matches = items;
    let active = -1;
    let open = false;
    let selectedKey = value;

    const input = el("input", {
        className: "form-select combobox-input",
        type: "text",
        role: "combobox",
        placeholder,
        spellcheck: "false",
        autocomplete: "off",
        "aria-expanded": "false",
        "aria-autocomplete": "list",
        // A disabled input fires no focus, input or key events, so the dropdown
        // handlers below need no separate guard.
        disabled,
    });

    const list = el("ul", { className: "combobox-list d-none", role: "listbox" });
    const clear = el("button", {
        type: "button",
        className: "btn btn-sm combobox-clear d-none",
        "aria-label": "Clear",
        textContent: "×",
    });

    render(mount, el("div", { className: "combobox" }, [input, clear, list]));

    function labelFor(key) {
        const item = items.find((i) => i.key === key);
        return item ? item.label : "";
    }

    if (selectedKey) {
        input.value = labelFor(selectedKey);
        clear.classList.toggle("d-none", disabled);
    }

    function setOpen(next) {
        open = next;
        list.classList.toggle("d-none", !open);
        input.setAttribute("aria-expanded", String(open));
        if (!open) active = -1;
    }

    function filter(query) {
        const needle = query.trim().toLowerCase();

        if (!needle) {
            matches = items;
            return;
        }

        matches = items
            .map((item) => ({ item, s: score(item, needle) }))
            .filter((row) => row.s > 0)
            .sort((a, b) => b.s - a.s || a.item.label.length - b.item.label.length)
            .map((row) => row.item);
    }

    function drawList() {
        if (matches.length === 0) {
            render(list, el("li", {
                className: "combobox-empty",
                textContent: "No services match.",
            }));
            return;
        }

        render(list, ...matches.slice(0, 200).map((item, i) =>
            el("li", {
                className: `combobox-option${i === active ? " active" : ""}`,
                role: "option",
                "aria-selected": String(i === active),
                // mousedown fires before the input's blur, so the click lands.
                onmousedown: (event) => {
                    event.preventDefault();
                    choose(i);
                },
            }, [
                el("span", { textContent: item.label }),
                el("span", { className: "combobox-key", textContent: item.key }),
            ]),
        ));
    }

    function choose(index) {
        const item = matches[index];
        if (!item) return;

        selectedKey = item.key;
        input.value = item.label;
        clear.classList.remove("d-none");
        setOpen(false);
        onSelect(item.key);
    }

    function scrollActiveIntoView() {
        list.children[active]?.scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("input", () => {
        filter(input.value);
        active = matches.length > 0 ? 0 : -1;
        setOpen(true);
        drawList();
    });

    /**
     * Show the whole list, highlighting the current selection.
     *
     * Reopening after a selection should offer everything again rather than
     * only what matches the label already sitting in the box.
     */
    function openAll() {
        // Select the committed label so the next keystroke replaces it instead
        // of appending to it — typing "k" into "Amazon EKS (eks)" would filter
        // on the whole string and match nothing.
        input.select();
        filter("");
        active = matches.findIndex((i) => i.key === selectedKey);
        setOpen(true);
        drawList();
        scrollActiveIntoView();
    }

    input.addEventListener("focus", openAll);

    // Committing a choice keeps focus on the input (the option's mousedown
    // preventDefault stops the blur), so a second click fires no focus event.
    // Without this the dropdown cannot be reopened without clicking away first.
    input.addEventListener("click", () => {
        if (!open) openAll();
    });

    input.addEventListener("blur", () => {
        setOpen(false);
        // Restore the committed label — a half-typed query is not a selection.
        input.value = selectedKey ? labelFor(selectedKey) : "";
    });

    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
                filter(input.value);
                setOpen(true);
            }
            const step = event.key === "ArrowDown" ? 1 : -1;
            active = (active + step + matches.length) % Math.max(matches.length, 1);
            drawList();
            scrollActiveIntoView();
            return;
        }

        if (event.key === "Enter") {
            if (open && active >= 0) {
                event.preventDefault();
                choose(active);
            }
            return;
        }

        if (event.key === "Escape") {
            setOpen(false);
            input.blur();
        }
    });

    clear.addEventListener("click", () => {
        selectedKey = null;
        input.value = "";
        clear.classList.add("d-none");
        setOpen(false);
        onSelect(null);
        input.focus();
    });

    return {
        setValue(key) {
            selectedKey = key;
            input.value = key ? labelFor(key) : "";
            clear.classList.toggle("d-none", !key);
        },
        focus() {
            input.focus();
        },
    };
}

export const _internal = { score, subsequenceScore, SCORE };
