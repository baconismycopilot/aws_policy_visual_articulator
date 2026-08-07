"use strict";

/**
 * The theme picker.
 *
 * A theme is a palette family (Slate, Parchment, Carbon) crossed with a mode
 * (light, dark). The six are declared as `:root[data-theme="…"]` blocks in
 * app.css; nothing here knows a colour. This module only decides *which* id
 * lands on the element and remembers the choice.
 *
 * Two attributes are stamped together and must never disagree:
 *
 *   data-theme     picks our --br-* token block
 *   data-bs-theme  puts Bootstrap's own chrome — tabs, selects, alerts, and the
 *                  chevron baked into .form-select as a data-URI SVG — in the
 *                  matching mode
 *
 * The mode is encoded in the id's suffix rather than looked up in a table, so
 * the pre-paint script in index.html can derive it without duplicating this
 * list. Renaming an id to something that does not end in `-light` or `-dark`
 * silently mismatches the two attributes.
 */

import { option } from "./dom.js";

const STORAGE_KEY = "apva.theme";

/** Stored when the choice is "whatever the OS says", rather than a theme id. */
export const SYSTEM = "system";

/**
 * The six, grouped by family. Order is the picker's order.
 *
 * `light` and `dark` for the same family are counterparts, not independent
 * palettes: SYSTEM resolves within a family, so switching your OS to light
 * should move you across a family's own pair rather than to a different one.
 */
export const FAMILIES = [
    { id: "slate", label: "Slate" },
    { id: "parchment", label: "Parchment" },
    { id: "carbon", label: "Carbon" },
];

export const THEMES = FAMILIES.flatMap(({ id, label }) => [
    { id: `${id}-light`, label: `${label} Light`, mode: "light" },
    { id: `${id}-dark`, label: `${label} Dark`, mode: "dark" },
]);

/**
 * The family SYSTEM follows. Slate is today's palette, so a first-time visitor
 * on a dark desktop sees exactly what the page has always looked like.
 */
const SYSTEM_FAMILY = "slate";

const isTheme = (id) => THEMES.some((theme) => theme.id === id);

/** dark unless the OS says otherwise — matching the page's long-standing look. */
function prefersDark() {
    return !window.matchMedia("(prefers-color-scheme: light)").matches;
}

/**
 * The stored preference: a theme id, or SYSTEM. Anything else — a hand-edited
 * entry, or an id from a build where the themes were named differently — is
 * discarded rather than stamped, which would leave `data-theme` matching no
 * block at all.
 */
export function storedPreference() {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Private browsing or a blocked storage partition. The picker still
        // works for the session; it just will not survive a reload.
    }
    return stored === SYSTEM || isTheme(stored) ? stored : SYSTEM;
}

/** The theme id a preference resolves to right now. */
export function resolveTheme(preference) {
    if (preference !== SYSTEM) return preference;
    return `${SYSTEM_FAMILY}-${prefersDark() ? "dark" : "light"}`;
}

/** Stamp a resolved theme id onto the document. */
export function applyTheme(id) {
    const root = document.documentElement;
    root.setAttribute("data-theme", id);
    root.setAttribute("data-bs-theme", id.endsWith("-dark") ? "dark" : "light");
}

/**
 * Wire the navbar's picker.
 *
 * Called before the data loads and outside its try, so the theme is right even
 * on the error path — `showFatal` renders an alert into this page like anything
 * else.
 */
export function initTheme() {
    const select = document.getElementById("theme-select");
    let preference = storedPreference();

    applyTheme(resolveTheme(preference));

    if (!select) return;

    select.replaceChildren(
        option(SYSTEM, "System"),
        ...THEMES.map((theme) => option(theme.id, theme.label)),
    );
    select.value = preference;

    select.addEventListener("change", () => {
        preference = select.value;
        applyTheme(resolveTheme(preference));
        try {
            localStorage.setItem(STORAGE_KEY, preference);
        } catch {
            // As above: the choice holds for the session regardless.
        }
    });

    // Only meaningful while the preference is SYSTEM, but the listener is
    // cheaper to leave attached than to add and remove as the choice changes.
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        if (preference === SYSTEM) applyTheme(resolveTheme(preference));
    });
}
