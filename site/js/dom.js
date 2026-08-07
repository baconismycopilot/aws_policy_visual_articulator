"use strict";

/**
 * Minimal DOM helpers.
 *
 * Everything is built with createElement and textContent rather than innerHTML:
 * action descriptions and ARN templates come from upstream JSON and land in the
 * page verbatim, so they must never be parsed as markup.
 *
 * A few helpers here know a little IAM — the access-level badge and the scope
 * marker — because both tabs render those and they must look the same in each.
 */

import { canScope, mustScope } from "./policy.js";

/**
 * @param {string} tag
 * @param {object} [attrs]  className, textContent, or any attribute name
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;

        if (key === "className") {
            node.className = value;
        } else if (key === "textContent") {
            node.textContent = value;
        } else if (key === "dataset") {
            Object.assign(node.dataset, value);
        } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(key, value === true ? "" : value);
        }
    }

    for (const child of children) {
        node.append(child);
    }

    return node;
}

/** Build a <table> with a header row. */
export function table(headers, rows, className = "table table-sm table-hover align-middle") {
    const thead = el("thead", {}, [
        el("tr", {}, headers.map((h) => el("th", { textContent: h, scope: "col" }))),
    ]);

    return el("table", { className }, [thead, el("tbody", {}, rows)]);
}

/** A badge coloured by IAM access level. */
export function accessLevelBadge(level) {
    // "Permissions management" -> level-Permissions, keeping the CSS names short.
    const slug = (level || "Unknown").split(" ")[0];
    return el("span", {
        className: `badge access-level level-${slug}`,
        textContent: level || "Unknown",
    });
}

/**
 * One badge per access level. Actions routinely carry two — "Tagging, Write"
 * and "Permissions management, Write" are common upstream values.
 * @param {Array<string>} levels
 * @returns {DocumentFragment}
 */
export function accessLevelBadges(levels) {
    const fragment = document.createDocumentFragment();

    for (const level of levels && levels.length ? levels : ["Unknown"]) {
        fragment.append(accessLevelBadge(level), document.createTextNode(" "));
    }

    return fragment;
}

/**
 * Whether an action can be scoped to an ARN.
 *
 * Both tabs show this — Browse in its scope column, Generate against the actions
 * you are picking — and it has to read identically in each, so the markup lives
 * here rather than being written twice.
 *
 * @param {object} action
 * @returns {HTMLElement}
 */
export function scopeMarker(action) {
    if (mustScope(action)) {
        const types = (action.resource_types || [])
            .filter((rt) => rt.required && rt.resource_type)
            .map((rt) => rt.resource_type);
        return el("span", {
            className: "scope-required",
            textContent: `required: ${types.join(", ")}`,
        });
    }
    if (canScope(action)) {
        return el("span", { className: "scope-optional", textContent: "optional" });
    }
    return el("span", { className: "scope-wildcard", textContent: '"*" only' });
}

export function option(value, label, selected = false) {
    return el("option", { value, textContent: label, selected });
}

/** Replace a container's children in one shot. */
export function render(container, ...children) {
    container.replaceChildren(...children.filter(Boolean));
}
