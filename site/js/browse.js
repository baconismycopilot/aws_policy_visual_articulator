"use strict";

/**
 * Browse tab: read-only exploration of a service's ARN formats, actions, and
 * condition keys.
 */

import { loadIndex, loadService } from "./data.js";
import { ACCESS_LEVELS, canScope, hasAccessLevel, mustScope } from "./policy.js";
import { accessLevelBadge, accessLevelBadges, el, option, render, table } from "./dom.js";

const ui = {};
let service = null;
const activeLevels = new Set();

export async function initBrowse(context) {
    ui.select = document.getElementById("browse-service");
    ui.filter = document.getElementById("browse-filter");
    ui.empty = document.getElementById("browse-empty");
    ui.body = document.getElementById("browse-body");
    ui.arns = document.getElementById("browse-arns");
    ui.levels = document.getElementById("browse-levels");
    ui.actions = document.getElementById("browse-actions");
    ui.conditions = document.getElementById("browse-conditions");
    ui.count = document.getElementById("browse-action-count");

    ui.context = context;

    const index = await loadIndex();
    render(
        ui.select,
        option("", "Select a service…"),
        ...index.map((entry) =>
            option(entry.prefix, `${entry.service_name} (${entry.prefix})`),
        ),
    );

    ui.select.addEventListener("change", async () => {
        if (!ui.select.value) {
            service = null;
            ui.empty.classList.remove("d-none");
            ui.body.classList.add("d-none");
            return;
        }
        service = await loadService(ui.select.value);
        activeLevels.clear();
        ui.filter.value = "";
        ui.empty.classList.add("d-none");
        ui.body.classList.remove("d-none");
        drawService();
    });

    ui.filter.addEventListener("input", drawActions);
}

/** Re-render ARN previews when the account context changes. */
export function refreshBrowse() {
    if (service) drawArns();
}

function drawService() {
    drawArns();
    drawLevelFilters();
    drawActions();
    drawConditions();
}

function drawArns() {
    const rows = (service.resources || []).map((resource) =>
        el("tr", {}, [
            el("td", { textContent: resource.resource }),
            el("td", { className: "arn-segment", textContent: resource.arn }),
            el("td", {
                textContent: (resource.condition_keys || []).join(", ") || "—",
            }),
        ]),
    );

    if (rows.length === 0) {
        const fallback = service.arn_format
            ? el("tr", {}, [
                  el("td", { textContent: "(from policy generator)" }),
                  el("td", { className: "arn-segment", textContent: service.arn_format }),
                  el("td", { textContent: "—" }),
              ])
            : el("tr", {}, [
                  el("td", {
                      colspan: "3",
                      className: "text-secondary",
                      textContent: "This service publishes no resource ARN formats.",
                  }),
              ]);
        rows.push(fallback);
    }

    render(ui.arns, table(["Resource type", "ARN format", "Condition keys"], rows));
}

function drawLevelFilters() {
    const buttons = ACCESS_LEVELS.map((level) => ({
        level,
        count: (service.actions || []).filter((a) => hasAccessLevel(a, level)).length,
    })).filter(({ count }) => count > 0).map(({ level, count }) => {
        return el("button", {
            type: "button",
            className: "btn btn-sm btn-outline-secondary",
            dataset: { level },
            onclick: (event) => {
                if (activeLevels.has(level)) activeLevels.delete(level);
                else activeLevels.add(level);
                event.currentTarget.classList.toggle("active", activeLevels.has(level));
                drawActions();
            },
        }, [accessLevelBadge(level), el("span", { textContent: ` ${count}` })]);
    });

    render(ui.levels, ...buttons);
}

function matchingActions() {
    const needle = ui.filter.value.trim().toLowerCase();

    return (service.actions || []).filter((action) => {
        if (activeLevels.size > 0 &&
            ![...activeLevels].some((level) => hasAccessLevel(action, level))) {
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

function drawActions() {
    const actions = matchingActions();
    ui.count.textContent = `${actions.length} of ${service.actions.length}`;

    const rows = actions.map((action) =>
        el("tr", {}, [
            el("td", { className: "arn-segment" }, [
                el("span", { textContent: `${service.prefix}:${action.name}` }),
            ]),
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

    render(ui.actions, table(["Action", "Access level", "Resource scope", "Description"], rows));
}

function drawConditions() {
    const rows = (service.conditions || []).map((condition) =>
        el("tr", {}, [
            el("td", { className: "arn-segment", textContent: condition.condition }),
            el("td", { textContent: condition.type }),
            el("td", {
                className: "description text-secondary",
                textContent: condition.description || "—",
            }),
        ]),
    );

    if (rows.length === 0) {
        rows.push(
            el("tr", {}, [
                el("td", {
                    colspan: "3",
                    className: "text-secondary",
                    textContent: "This service publishes no service-specific condition keys.",
                }),
            ]),
        );
    }

    render(ui.conditions, table(["Condition key", "Type", "Description"], rows));
}
