"use strict";

/**
 * The theme picker.
 *
 * A theme is a palette family (Slate, Parchment, Carbon) crossed with a mode
 * (light, dark). The six are declared as `:root[data-theme="…"]` blocks in
 * app.css; nothing here knows a colour. This module only decides *which* id
 * lands on the element and remembers the choice.
 *
 * What is stored is a *preference*, not a theme: `<family>-<mode>`, where mode
 * may also be `system`. That is what lets the two controls stay independent --
 * following the OS is a property of the mode, so it no longer costs you the
 * choice of family the way a single flat list of themes did.
 *
 * A preference whose mode is `light` or `dark` is already a theme id, and one
 * ending in `-system` becomes one by substituting the suffix. Both directions
 * are pure string work, which is the point: the pre-paint script in index.html
 * has to do the same job before any module loads, and can do it without a copy
 * of the tables below.
 *
 * Two attributes are stamped together and must never disagree:
 *
 *   data-theme     picks our --br-* token block
 *   data-bs-theme  puts Bootstrap's own chrome — tabs, selects, alerts, and the
 *                  chevron baked into .form-select as a data-URI SVG — in the
 *                  matching mode
 *
 * The mode is read off the id's suffix rather than looked up, so renaming a
 * family to something containing a hyphen, or a mode to something that is not
 * the id's last segment, silently mismatches the two attributes.
 */

import { option } from "./dom.js";

const STORAGE_KEY = "apva.theme";

/** Order is the family picker's order. */
export const FAMILIES = [
    { id: "slate", label: "Slate" },
    { id: "parchment", label: "Parchment" },
    { id: "carbon", label: "Carbon" },
];

/** Order is the mode picker's order. `system` leads because it is the default. */
export const MODES = [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
];

/** The six concrete themes: every family crossed with the two real modes. */
export const THEMES = FAMILIES.flatMap(({ id, label }) => [
    { id: `${id}-light`, label: `${label} Light`, mode: "light" },
    { id: `${id}-dark`, label: `${label} Dark`, mode: "dark" },
]);

/**
 * Slate following the OS. Slate is the palette the page shipped with, so a
 * first-time visitor on a dark desktop sees exactly what it has always been.
 */
const DEFAULT_PREFERENCE = "slate-system";

/**
 * Split `<family>-<mode>`, or null if either half names nothing.
 *
 * Cut at the *last* hyphen: family ids are single words today, but a two-word
 * one would break a split-on-first, and the mode is always the final segment.
 */
function parse(preference) {
    const cut = String(preference).lastIndexOf("-");
    if (cut < 0) return null;

    const family = preference.slice(0, cut);
    const mode = preference.slice(cut + 1);

    if (!FAMILIES.some((f) => f.id === family)) return null;
    if (!MODES.some((m) => m.id === mode)) return null;
    return { family, mode };
}

/** dark unless the OS says otherwise — matching the page's long-standing look. */
function prefersDark() {
    return !window.matchMedia("(prefers-color-scheme: light)").matches;
}

/**
 * The stored preference, or the default.
 *
 * Anything unparseable is discarded rather than stamped, which would leave
 * `data-theme` matching no block at all: a hand-edited entry, or a family from
 * a build where they were named differently.
 */
export function storedPreference() {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Private browsing or a blocked storage partition. The picker still
        // works for the session; it just will not survive a reload.
    }

    // The single-select picker wrote a bare "system" for "follow the OS". It
    // named no family because there was only one it could mean. Anything else
    // it wrote was a theme id, which is already a valid `<family>-<mode>`.
    if (stored === "system") return DEFAULT_PREFERENCE;

    return parse(stored) ? stored : DEFAULT_PREFERENCE;
}

/** The theme id a preference resolves to right now. */
export function resolveTheme(preference) {
    const { family, mode } = parse(preference) ?? parse(DEFAULT_PREFERENCE);
    return `${family}-${mode === "system" ? (prefersDark() ? "dark" : "light") : mode}`;
}

/** Stamp a resolved theme id onto the document. */
export function applyTheme(id) {
    const root = document.documentElement;
    root.setAttribute("data-theme", id);
    root.setAttribute("data-bs-theme", id.endsWith("-dark") ? "dark" : "light");
}

/**
 * Wire the navbar's two selects.
 *
 * Called before the data loads and outside its try, so the theme is right even
 * on the error path — `showFatal` renders an alert into this page like anything
 * else.
 */
export function initTheme() {
    const familySelect = document.getElementById("theme-family");
    const modeSelect = document.getElementById("theme-mode");
    let preference = storedPreference();

    applyTheme(resolveTheme(preference));

    if (!familySelect || !modeSelect) return;

    familySelect.replaceChildren(...FAMILIES.map((f) => option(f.id, f.label)));
    modeSelect.replaceChildren(...MODES.map((m) => option(m.id, m.label)));

    const { family, mode } = parse(preference);
    familySelect.value = family;
    modeSelect.value = mode;

    const onChange = () => {
        preference = `${familySelect.value}-${modeSelect.value}`;
        applyTheme(resolveTheme(preference));
        try {
            localStorage.setItem(STORAGE_KEY, preference);
        } catch {
            // As above: the choice holds for the session regardless.
        }
    };

    familySelect.addEventListener("change", onChange);
    modeSelect.addEventListener("change", onChange);

    // Only meaningful while the mode is `system`, but the listener is cheaper to
    // leave attached than to add and remove as the choice changes.
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        if (preference.endsWith("-system")) applyTheme(resolveTheme(preference));
    });
}
