"use strict";

/**
 * Browse tab: find a service, then read its actions.
 *
 * ARN formats and service condition keys used to live here too, but they are
 * only actionable while assembling a statement, so they belong to the Generate
 * tab and were removed rather than duplicated.
 */

import { loadIndex, loadService } from "./data.js";
import { ACCESS_LEVELS, canScope, hasAccessLevel, mustScope } from "./policy.js";
import { accessLevelBadge, accessLevelBadges, el, render, table } from "./dom.js";
import { combobox } from "./combobox.js";

const DOCS_BASE = "https://docs.aws.amazon.com/service-authorization/latest/reference/";

const ui = {};
let service = null;
const activeLevels = new Set();

export async function initBrowse() {
    ui.filter = document.getElementById("browse-filter");
    ui.empty = document.getElementById("browse-empty");
    ui.body = document.getElementById("browse-body");
    ui.levels = document.getElementById("browse-levels");
    ui.actions = document.getElementById("browse-actions");
    ui.count = document.getElementById("browse-action-count");
    ui.docLink = document.getElementById("browse-doc-link");

    const index = await loadIndex();

    ui.combo = combobox({
        mount: document.getElementById("browse-service"),
        placeholder: `Search ${index.length} services — name or IAM prefix`,
        items: index.map((entry) => ({
            key: entry.prefix,
            label: `${entry.service_name} (${entry.prefix})`,
        })),
        onSelect: async (prefix) => {
            if (!prefix) {
                service = null;
                ui.empty.classList.remove("d-none");
                ui.body.classList.add("d-none");
                return;
            }
            service = await loadService(prefix);
            activeLevels.clear();
            ui.filter.value = "";
            ui.empty.classList.add("d-none");
            ui.body.classList.remove("d-none");
            drawService();
        },
    });

    ui.filter.addEventListener("input", drawActions);
}

/**
 * Documentation URL for an action in the Service Authorization Reference.
 *
 * The page stem comes from the reference's own table of contents — it is not
 * derivable from the prefix, as 62 services disagree (airflow -> list_mwaa).
 */
function docUrl(svc, actionName) {
    if (!svc.doc_page) return null;
    const page = `${DOCS_BASE}${svc.doc_page}.html`;
    return actionName ? `${page}#${svc.doc_page}-action-${actionName}` : page;
}

function drawService() {
    const url = docUrl(service, null);
    if (url) {
        ui.docLink.href = url;
        ui.docLink.textContent = `${service.service_name} reference ↗`;
        ui.docLink.classList.remove("d-none");
    } else {
        ui.docLink.classList.add("d-none");
    }

    drawLevelFilters();
    drawActions();
}

function drawLevelFilters() {
    const buttons = ACCESS_LEVELS.map((level) => ({
        level,
        count: (service.actions || []).filter((a) => hasAccessLevel(a, level)).length,
    }))
        .filter(({ count }) => count > 0)
        .map(({ level, count }) =>
            el("button", {
                type: "button",
                className: "btn btn-sm btn-outline-secondary",
                dataset: { level },
                onclick: (event) => {
                    if (activeLevels.has(level)) activeLevels.delete(level);
                    else activeLevels.add(level);
                    event.currentTarget.classList.toggle("active", activeLevels.has(level));
                    drawActions();
                },
            }, [accessLevelBadge(level), el("span", { textContent: ` ${count}` })]),
        );

    render(ui.levels, ...buttons);
}

function matchingActions() {
    const needle = ui.filter.value.trim().toLowerCase();

    return (service.actions || []).filter((action) => {
        if (
            activeLevels.size > 0 &&
            ![...activeLevels].some((level) => hasAccessLevel(action, level))
        ) {
            return false;
        }
        if (!needle) return true;
        return (
            action.name.toLowerCase().includes(needle) ||
            (action.description || "").toLowerCase().includes(needle)
        );
    });
}

function scopeCell(action) {
    if (mustScope(action)) {
        const types = (action.resource_types || [])
            .filter((rt) => rt.required && rt.resource_type)
            .map((rt) => rt.resource_type);
        return el("span", {
            className: "text-warning",
            textContent: `required: ${types.join(", ")}`,
        });
    }
    if (canScope(action)) {
        return el("span", { className: "text-secondary", textContent: "optional" });
    }
    return el("span", { className: "text-secondary", textContent: '"*" only' });
}

function actionCell(action) {
    const qualified = `${service.prefix}:${action.name}`;
    const url = docUrl(service, action.name);

    if (!url) {
        return el("span", { className: "arn-segment", textContent: qualified });
    }

    return el("a", {
        className: "arn-segment action-link",
        href: url,
        target: "_blank",
        rel: "noopener",
        title: `${qualified} in the Service Authorization Reference`,
    }, [el("span", { textContent: qualified })]);
}

function drawActions() {
    const actions = matchingActions();
    ui.count.textContent = `${actions.length} of ${service.actions.length}`;

    const rows = actions.map((action) =>
        el("tr", {}, [
            el("td", {}, [actionCell(action)]),
            el("td", {}, [accessLevelBadges(action.access_levels)]),
            el("td", {}, [scopeCell(action)]),
            el("td", {
                className: "description text-secondary",
                textContent: action.description || "—",
            }),
        ]),
    );

    if (rows.length === 0) {
        rows.push(
            el("tr", {}, [
                el("td", {
                    colspan: "4",
                    className: "text-secondary",
                    textContent: "No actions match.",
                }),
            ]),
        );
    }

    render(
        ui.actions,
        table(["Action", "Access level", "Resource scope", "Description"], rows),
    );
}
