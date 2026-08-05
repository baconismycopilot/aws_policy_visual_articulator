"use strict";

/**
 * Generate tab: build an IAM policy document from the same dataset the Browse
 * tab reads, with validation driven by the resource-type and dependent-action
 * metadata AWS publishes.
 */

import { conditionKeysFor, loadGlobal, loadIndex, loadService, peekService } from "./data.js";
import { renderArn, userPlaceholders } from "./arn.js";
import {
    ACCESS_LEVELS,
    POLICY_TYPES,
    PRINCIPAL_TYPES,
    buildPolicy,
    emptyStatement,
    hasAccessLevel,
    resourceTypesFor,
    validate,
} from "./policy.js";
import { accessLevelBadge, accessLevelBadges, el, option, render } from "./dom.js";
import { combobox } from "./combobox.js";

/** Rendering every action of a large service (ec2 has ~1,800) is sluggish. */
const MAX_PICKER_ROWS = 300;

const ui = {};
let context = null;
let globalData = null;
let serviceIndex = [];

const state = {
    policyType: "IAMPolicy",
    statements: [emptyStatement()],
};

/** Per-statement transient UI state that does not belong in the document. */
const uiState = new WeakMap();

export async function initGenerate(sharedContext) {
    context = sharedContext;

    ui.policyType = document.getElementById("gen-policy-type");
    ui.policyHint = document.getElementById("gen-policy-hint");
    ui.statements = document.getElementById("gen-statements");
    ui.addStatement = document.getElementById("gen-add-statement");
    ui.output = document.getElementById("gen-output");
    ui.findings = document.getElementById("gen-findings");
    ui.size = document.getElementById("gen-size");
    ui.copy = document.getElementById("gen-copy");
    ui.download = document.getElementById("gen-download");

    [globalData, serviceIndex] = await Promise.all([loadGlobal(), loadIndex()]);

    render(
        ui.policyType,
        ...Object.entries(POLICY_TYPES).map(([key, spec]) => option(key, spec.name)),
    );
    ui.policyType.value = state.policyType;
    ui.policyType.addEventListener("change", async () => {
        state.policyType = ui.policyType.value;
        await applyPolicyTypeDefaults();
        drawStatements();
    });

    ui.addStatement.addEventListener("click", () => {
        state.statements.push(emptyStatement());
        drawStatements();
    });

    ui.copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(currentJSON());
        flash(ui.copy, "Copied");
    });

    ui.download.addEventListener("click", () => {
        const blob = new Blob([currentJSON()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = el("a", { href: url, download: "policy.json" });
        link.click();
        URL.revokeObjectURL(url);
    });

    drawStatements();
}

/**
 * Re-render when the account context changes.
 *
 * The document is rebuilt from `context` on every call, but the ARN preview
 * under each resource row is written once at render time — so the resource
 * sections have to be redrawn too, or the preview silently disagrees with the
 * JSON it is meant to be previewing.
 */
export function refreshGenerate() {
    if (!ui.output) return;

    const spec = POLICY_TYPES[state.policyType];
    for (const statement of state.statements) {
        if (uiState.has(statement)) drawResourceSection(statement, spec);
    }

    drawOutput();
}

function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => {
        button.textContent = original;
    }, 1200);
}

/**
 * Resource-based policy types are pinned to one service, and trust policies
 * start on sts:AssumeRole. Apply those defaults when the type changes.
 */
async function applyPolicyTypeDefaults() {
    const spec = POLICY_TYPES[state.policyType];

    for (const statement of state.statements) {
        if (spec.servicePrefix && statement.servicePrefix !== spec.servicePrefix) {
            statement.servicePrefix = spec.servicePrefix;
            statement.actions = [];
            statement.resources = [];
            await loadService(spec.servicePrefix);
        }

        if (spec.defaultActions && statement.actions.length === 0) {
            const [prefix, name] = spec.defaultActions[0].split(":");
            statement.servicePrefix = prefix;
            await loadService(prefix);
            statement.actions = [name];
            statement.anyResource = true;
        }
    }
}

// --- statement rendering ------------------------------------------------------

function drawStatements() {
    const spec = POLICY_TYPES[state.policyType];
    ui.policyHint.textContent = spec.hint;

    render(ui.statements, ...state.statements.map((s, i) => statementCard(s, i, spec)));
    drawOutput();
}

function statementCard(statement, index, spec) {
    const body = el("div", { className: "card-body vstack gap-3" });

    const card = el("div", { className: "card statement-card" }, [
        el("div", { className: "card-header" }, [
            el("span", { className: "fw-semibold", textContent: `Statement ${index + 1}` }),
            effectToggle(statement),
            el("input", {
                className: "form-control form-control-sm w-auto ms-2",
                placeholder: "Sid (optional)",
                value: statement.sid,
                spellcheck: "false",
                oninput: (event) => {
                    statement.sid = event.target.value;
                    drawOutput();
                },
            }),
            el("button", {
                type: "button",
                className: "btn btn-sm btn-outline-danger ms-auto",
                textContent: "Remove",
                disabled: state.statements.length === 1,
                onclick: () => {
                    state.statements.splice(index, 1);
                    drawStatements();
                },
            }),
        ]),
        body,
    ]);

    const refs = {};
    uiState.set(statement, { ...(uiState.get(statement) || {}), refs });

    body.append(serviceRow(statement, spec));

    if (spec.principal !== "none") {
        body.append(principalSection(statement, spec));
    }

    refs.actions = el("div", {});
    refs.resources = el("div", {});
    refs.conditions = el("div", {});
    body.append(refs.actions, refs.resources, refs.conditions);

    drawActionSection(statement);
    drawResourceSection(statement, spec);
    drawConditionSection(statement);

    return card;
}

function effectToggle(statement) {
    return el("select", {
        className: "form-select form-select-sm w-auto",
        onchange: (event) => {
            statement.effect = event.target.value;
            drawOutput();
        },
    }, [
        option("Allow", "Allow", statement.effect === "Allow"),
        option("Deny", "Deny", statement.effect === "Deny"),
    ]);
}

function serviceRow(statement, spec) {
    const mount = el("div", {});
    // Resource-based policy types are pinned to their own service, so the
    // picker is shown filled but locked rather than hidden.
    const pinned = Boolean(spec.servicePrefix);

    combobox({
        mount,
        items: serviceIndex.map((entry) => ({
            key: entry.prefix,
            label: `${entry.service_name} (${entry.prefix})`,
        })),
        placeholder: `Search ${serviceIndex.length} services — name or IAM prefix`,
        value: statement.servicePrefix || null,
        disabled: pinned,
        onSelect: async (prefix) => {
            statement.servicePrefix = prefix || "";
            statement.actions = [];
            statement.wildcardAction = false;
            statement.resources = [];
            statement.conditions = [];
            if (statement.servicePrefix) await loadService(statement.servicePrefix);
            drawStatements();
        },
    });

    return el("div", {}, [
        el("label", { className: "form-label" }, [
            el("span", { textContent: "Service" }),
            pinned
                ? el("span", {
                      className: "text-secondary small ms-2",
                      textContent: `fixed by ${spec.name}`,
                  })
                : null,
        ].filter(Boolean)),
        mount,
    ]);
}

function principalSection(statement, spec) {
    const typeSelect = el("select", {
        className: "form-select w-auto",
        onchange: (event) => {
            statement.principalType = event.target.value;
            drawStatements();
        },
    }, Object.entries(PRINCIPAL_TYPES).map(([key, label]) =>
        option(key, label, key === statement.principalType),
    ));

    const children = [
        el("label", { className: "form-label" }, [
            el("span", { textContent: "Principal" }),
            spec.principal === "required"
                ? el("span", { className: "text-danger", textContent: " *" })
                : null,
        ].filter(Boolean)),
        el("div", { className: "d-flex gap-2 align-items-start" }, [typeSelect]),
    ];

    if (statement.principalType !== "*") {
        children[1].append(
            el("textarea", {
                className: "form-control arn-segment",
                rows: "2",
                spellcheck: "false",
                placeholder: principalPlaceholder(statement.principalType),
                value: statement.principalValues,
                oninput: (event) => {
                    statement.principalValues = event.target.value;
                    drawOutput();
                },
            }),
        );
    }

    children.push(
        el("div", {
            className: "form-text",
            textContent: "One per line, or comma-separated.",
        }),
    );

    return el("div", {}, children);
}

function principalPlaceholder(type) {
    return {
        AWS: "arn:aws:iam::111122223333:root",
        Service: "lambda.amazonaws.com",
        Federated: "arn:aws:iam::111122223333:oidc-provider/…",
        CanonicalUser: "79a59df900b949e55d96a1e698fbaced…",
    }[type] || "";
}

// --- actions ------------------------------------------------------------------

function drawActionSection(statement) {
    const refs = uiState.get(statement).refs;
    const service = peekService(statement.servicePrefix);

    if (!service) {
        render(refs.actions, el("div", {
            className: "text-secondary small",
            textContent: "Select a service to choose actions.",
        }));
        return;
    }

    const local = uiState.get(statement);
    local.filter ??= "";
    local.levels ??= new Set();

    refs.actionCount = el("span", { className: "badge text-bg-secondary" });

    const header = el("div", { className: "d-flex align-items-center gap-2 mb-2" }, [
        el("label", { className: "form-label mb-0", textContent: "Actions" }),
        refs.actionCount,
        el("div", { className: "form-check form-switch ms-auto" }, [
            el("input", {
                className: "form-check-input",
                type: "checkbox",
                id: `wildcard-${statement.servicePrefix}-${state.statements.indexOf(statement)}`,
                checked: statement.wildcardAction,
                onchange: (event) => {
                    statement.wildcardAction = event.target.checked;
                    drawActionSection(statement);
                    drawResourceSection(statement, POLICY_TYPES[state.policyType]);
                    drawOutput();
                },
            }),
            el("label", {
                className: "form-check-label small",
                for: `wildcard-${statement.servicePrefix}-${state.statements.indexOf(statement)}`,
                textContent: `${statement.servicePrefix}:*`,
            }),
        ]),
    ]);

    if (statement.wildcardAction) {
        render(refs.actions, header, el("div", {
            className: "text-secondary small",
            textContent: `Granting all ${service.actions.length} actions in this service.`,
        }));
        drawActionCount(statement);
        return;
    }

    const search = el("input", {
        className: "form-control form-control-sm mb-2",
        placeholder: "Filter actions",
        value: local.filter,
        spellcheck: "false",
        oninput: (event) => {
            local.filter = event.target.value;
            drawPicker(statement);
        },
    });

    const levels = el("div", { className: "d-flex flex-wrap gap-1 mb-2" },
        ACCESS_LEVELS
            .filter((level) => service.actions.some((a) => hasAccessLevel(a, level)))
            .map((level) => el("button", {
                type: "button",
                className: `btn btn-sm btn-outline-secondary${local.levels.has(level) ? " active" : ""}`,
                onclick: (event) => {
                    if (local.levels.has(level)) local.levels.delete(level);
                    else local.levels.add(level);
                    event.currentTarget.classList.toggle("active", local.levels.has(level));
                    drawPicker(statement);
                },
            }, [accessLevelBadge(level)])),
    );

    refs.picker = el("div", { className: "action-picker" });

    render(refs.actions, header, search, levels, refs.picker, selectionTools(statement));
    drawActionCount(statement);
    drawPicker(statement);
}

/** Keep the "N selected" badge in step with the checkboxes. */
function drawActionCount(statement) {
    const badge = uiState.get(statement)?.refs?.actionCount;
    if (!badge) return;

    badge.textContent = statement.wildcardAction
        ? "all"
        : `${statement.actions.length} selected`;
}

function selectionTools(statement) {
    return el("div", { className: "d-flex gap-2 mt-2" }, [
        el("button", {
            type: "button",
            className: "btn btn-sm btn-link p-0",
            textContent: "Select all shown",
            onclick: () => {
                const shown = visibleActions(statement).map((a) => a.name);
                statement.actions = [...new Set([...statement.actions, ...shown])];
                drawActionSection(statement);
                drawResourceSection(statement, POLICY_TYPES[state.policyType]);
                drawOutput();
            },
        }),
        el("button", {
            type: "button",
            className: "btn btn-sm btn-link p-0",
            textContent: "Clear",
            onclick: () => {
                statement.actions = [];
                drawActionSection(statement);
                drawResourceSection(statement, POLICY_TYPES[state.policyType]);
                drawOutput();
            },
        }),
    ]);
}

function visibleActions(statement) {
    const service = peekService(statement.servicePrefix);
    const local = uiState.get(statement);
    const needle = (local.filter || "").trim().toLowerCase();

    return (service.actions || []).filter((action) => {
        if (local.levels.size > 0 &&
            ![...local.levels].some((level) => hasAccessLevel(action, level))) {
            return false;
        }
        if (!needle) return true;
        return (
            action.name.toLowerCase().includes(needle) ||
            (action.description || "").toLowerCase().includes(needle)
        );
    });
}

function drawPicker(statement) {
    const refs = uiState.get(statement).refs;
    const selected = new Set(statement.actions);
    const matches = visibleActions(statement);
    const shown = matches.slice(0, MAX_PICKER_ROWS);

    const rows = shown.map((action) => {
        const id = `act-${statement.servicePrefix}-${action.name}-${state.statements.indexOf(statement)}`;
        return el("div", { className: "form-check" }, [
            el("input", {
                className: "form-check-input",
                type: "checkbox",
                id,
                checked: selected.has(action.name),
                onchange: (event) => {
                    if (event.target.checked) statement.actions.push(action.name);
                    else statement.actions = statement.actions.filter((n) => n !== action.name);
                    // Available resource types depend on the selection, so the
                    // resource section must follow. The picker itself is left
                    // alone to preserve scroll position.
                    // The picker is deliberately not redrawn (it would lose
                    // scroll position), so the count badge is updated by hand.
                    drawActionCount(statement);
                    drawResourceSection(statement, POLICY_TYPES[state.policyType]);
                    drawConditionSection(statement);
                    drawOutput();
                },
            }),
            el("label", { className: "form-check-label", for: id }, [
                el("span", { className: "arn-segment", textContent: action.name }),
                el("span", { textContent: " " }),
                accessLevelBadges(action.access_levels),
                action.description
                    ? el("div", {
                          className: "small text-secondary",
                          textContent: action.description,
                      })
                    : null,
            ].filter(Boolean)),
        ]);
    });

    if (matches.length > shown.length) {
        rows.push(el("div", {
            className: "small text-secondary pt-2",
            textContent: `Showing ${shown.length} of ${matches.length}. Filter to narrow.`,
        }));
    }

    if (rows.length === 0) {
        rows.push(el("div", { className: "small text-secondary", textContent: "No actions match." }));
    }

    render(refs.picker, ...rows);
}

// --- resources ----------------------------------------------------------------

function drawResourceSection(statement, spec) {
    const refs = uiState.get(statement).refs;

    if (spec.resource === "none") {
        render(refs.resources);
        return;
    }

    const service = peekService(statement.servicePrefix);
    if (!service) {
        render(refs.resources);
        return;
    }

    syncResourceRows(statement, service);

    const toggle = el("div", { className: "d-flex gap-3 mb-2" }, [
        radio(statement, "anyResource", true, 'Any resource ("*")'),
        radio(statement, "anyResource", false, "Specific ARNs", statement.resources.length === 0),
    ]);

    const children = [
        el("label", { className: "form-label", textContent: "Resources" }),
        toggle,
    ];

    if (!statement.anyResource) {
        children.push(...statement.resources.map((row) => arnRow(statement, row)));
        if (statement.resources.length === 0) {
            children.push(el("div", {
                className: "small text-secondary",
                textContent: "The selected actions have no resource types to scope to.",
            }));
        }
    }

    render(refs.resources, el("div", {}, children));
}

function radio(statement, field, value, label, disabled = false) {
    const id = `${field}-${value}-${state.statements.indexOf(statement)}`;
    return el("div", { className: "form-check" }, [
        el("input", {
            className: "form-check-input",
            type: "radio",
            name: `${field}-${state.statements.indexOf(statement)}`,
            id,
            checked: statement[field] === value,
            disabled,
            onchange: () => {
                statement[field] = value;
                drawResourceSection(statement, POLICY_TYPES[state.policyType]);
                drawOutput();
            },
        }),
        el("label", { className: "form-check-label", for: id, textContent: label }),
    ]);
}

/**
 * Rebuild the ARN rows to match the current action selection, preserving any
 * values the user already typed for a resource type that is still relevant.
 */
function syncResourceRows(statement, service) {
    const wanted = statement.wildcardAction
        ? (service.resources || []).map((r) => ({ resource_type: r.resource, required: false }))
        : resourceTypesFor(service, statement.actions);

    const byType = new Map(statement.resources.map((r) => [r.resourceType, r]));

    statement.resources = wanted
        .map(({ resource_type, required }) => {
            const definition = (service.resources || []).find(
                (r) => r.resource === resource_type,
            );
            if (!definition) return null;

            const existing = byType.get(resource_type);
            return {
                resourceType: resource_type,
                required,
                template: definition.arn,
                values: existing ? existing.values : {},
            };
        })
        .filter(Boolean);
}

function arnRow(statement, row) {
    const preview = el("div", { className: "arn-preview" });

    const updatePreview = () => {
        preview.textContent = renderArn(row.template, context, row.values);
        drawOutput();
    };

    const inputs = userPlaceholders(row.template).map((name) =>
        el("div", { className: "col-sm-6" }, [
            el("label", { className: "form-label small mb-0", textContent: name }),
            el("input", {
                className: "form-control form-control-sm arn-segment",
                placeholder: "*",
                value: row.values[name] || "",
                spellcheck: "false",
                oninput: (event) => {
                    row.values[name] = event.target.value;
                    updatePreview();
                },
            }),
        ]),
    );

    preview.textContent = renderArn(row.template, context, row.values);

    return el("div", { className: "border rounded p-2 mb-2" }, [
        el("div", { className: "d-flex align-items-center gap-2 mb-1" }, [
            el("span", { className: "fw-semibold small", textContent: row.resourceType }),
            row.required
                ? el("span", { className: "badge text-bg-warning", textContent: "required" })
                : el("span", { className: "badge text-bg-secondary", textContent: "optional" }),
        ]),
        el("div", { className: "row g-2" }, inputs),
        el("div", { className: "mt-1" }, [preview]),
    ]);
}

// --- conditions ---------------------------------------------------------------

function drawConditionSection(statement) {
    const refs = uiState.get(statement).refs;
    const service = peekService(statement.servicePrefix);

    if (!service) {
        render(refs.conditions);
        return;
    }

    const keys = conditionKeysFor(service, statement.actions);

    const rows = statement.conditions.map((row, i) =>
        el("div", { className: "row g-2 mb-2 align-items-end" }, [
            el("div", { className: "col-sm-4" }, [
                el("select", {
                    className: "form-select form-select-sm",
                    onchange: (event) => {
                        row.key = event.target.value;
                        drawOutput();
                    },
                }, [
                    option("", "Condition key…"),
                    ...keys.map((key) => option(key, key, key === row.key)),
                ]),
            ]),
            el("div", { className: "col-sm-3" }, [
                el("select", {
                    className: "form-select form-select-sm",
                    onchange: (event) => {
                        row.operator = event.target.value;
                        drawOutput();
                    },
                }, [
                    option("", "Operator…"),
                    ...globalData.condition_operators.map((op) =>
                        option(op, op, op === row.operator),
                    ),
                ]),
            ]),
            el("div", { className: "col-sm-4" }, [
                el("input", {
                    className: "form-control form-control-sm arn-segment",
                    placeholder: "Value (comma-separated for a list)",
                    value: row.value,
                    spellcheck: "false",
                    oninput: (event) => {
                        row.value = event.target.value;
                        drawOutput();
                    },
                }),
            ]),
            el("div", { className: "col-sm-1" }, [
                el("button", {
                    type: "button",
                    className: "btn btn-sm btn-outline-danger",
                    textContent: "×",
                    onclick: () => {
                        statement.conditions.splice(i, 1);
                        drawConditionSection(statement);
                        drawOutput();
                    },
                }),
            ]),
        ]),
    );

    render(refs.conditions, el("div", {}, [
        el("div", { className: "d-flex align-items-center gap-2 mb-2" }, [
            el("label", { className: "form-label mb-0", textContent: "Conditions" }),
            el("button", {
                type: "button",
                className: "btn btn-sm btn-outline-secondary",
                textContent: "+ Add",
                onclick: () => {
                    statement.conditions.push({ key: "", operator: "StringEquals", value: "" });
                    drawConditionSection(statement);
                },
            }),
        ]),
        ...rows,
    ]));
}

// --- output -------------------------------------------------------------------

function currentJSON() {
    return JSON.stringify(
        buildPolicy(state.policyType, state.statements, context, peekService),
        null,
        2,
    );
}

function drawOutput() {
    const json = currentJSON();
    ui.output.textContent = json;

    const bytes = new TextEncoder().encode(json).length;
    ui.size.textContent = `${bytes} bytes`;
    // Managed policies cap at 6,144 characters of non-whitespace.
    ui.size.classList.toggle("text-bg-danger", json.replace(/\s/g, "").length > 6144);

    const findings = validate(state.policyType, state.statements, peekService);

    render(ui.findings, ...(findings.length === 0
        ? [el("div", { className: "finding finding-info", textContent: "No issues found." })]
        : findings.map(findingCard)));
}

function findingCard(finding) {
    const label = finding.statement >= 0 ? `Statement ${finding.statement + 1}: ` : "";

    const children = [
        el("span", { className: "fw-semibold", textContent: label }),
        el("span", { textContent: finding.message }),
    ];

    if (finding.fix) {
        children.push(el("div", { className: "mt-1" }, [
            el("button", {
                type: "button",
                className: "btn btn-sm btn-outline-info",
                textContent: finding.fix.label,
                onclick: () => applyFix(finding),
            }),
        ]));
    }

    return el("div", { className: `finding finding-${finding.level}` }, children);
}

/**
 * Add dependent actions. Those in another service need a new statement, since a
 * statement is scoped to one service prefix in this UI.
 */
async function applyFix(finding) {
    const statement = state.statements[finding.statement];
    const sameService = [];
    const otherServices = new Map();

    for (const qualified of finding.fix.actions) {
        const [prefix, name] = qualified.split(":");
        if (prefix === statement.servicePrefix) {
            sameService.push(name);
        } else {
            if (!otherServices.has(prefix)) otherServices.set(prefix, []);
            otherServices.get(prefix).push(name);
        }
    }

    statement.actions = [...new Set([...statement.actions, ...sameService])];

    for (const [prefix, names] of otherServices) {
        await loadService(prefix);
        const extra = emptyStatement();
        extra.servicePrefix = prefix;
        extra.actions = names;
        extra.sid = `Dependencies${prefix.replace(/[^A-Za-z0-9]/g, "")}`;
        state.statements.push(extra);
    }

    drawStatements();
}
