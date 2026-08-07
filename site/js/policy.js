"use strict";

/**
 * Policy document construction and validation.
 *
 * Pure functions over plain objects — no DOM. Everything the generator knows
 * about IAM semantics lives here.
 */

import { renderArn } from "./arn.js";

/**
 * Structural rules per policy type.
 *
 * policies.js supplies the display names and associated services but says
 * nothing about which blocks each type requires, so the shape is encoded here.
 * `TrustPolicy` is not in the upstream list at all — it is a role trust policy,
 * which is a resource-based policy on the role itself.
 */
export const POLICY_TYPES = {
    IAMPolicy: {
        name: "IAM Policy",
        principal: "none",
        resource: "required",
        hint: "Attached to a user, group, or role.",
    },
    S3Policy: {
        name: "S3 Bucket Policy",
        principal: "required",
        resource: "required",
        servicePrefix: "s3",
        hint: "Attached to a bucket. Resource must be the bucket or its objects.",
    },
    SQSPolicy: {
        name: "SQS Queue Policy",
        principal: "required",
        resource: "required",
        servicePrefix: "sqs",
        hint: "Attached to a queue.",
    },
    SNSPolicy: {
        name: "SNS Topic Policy",
        principal: "required",
        resource: "required",
        servicePrefix: "sns",
        hint: "Attached to a topic.",
    },
    VPCPolicy: {
        name: "VPC Endpoint Policy",
        principal: "optional",
        resource: "required",
        hint: "Attached to a VPC endpoint. Principal is usually *.",
    },
    TrustPolicy: {
        name: "Role Trust Policy",
        principal: "required",
        resource: "none",
        defaultActions: ["sts:AssumeRole"],
        hint: "Who may assume the role. Has no Resource block.",
    },
};

export const PRINCIPAL_TYPES = {
    AWS: "AWS account / IAM ARN",
    Service: "AWS service",
    Federated: "Federated identity provider",
    CanonicalUser: "S3 canonical user ID",
    "*": "Anyone (public)",
};

/**
 * The canonical levels. An action can carry more than one, so these are matched
 * with `hasAccessLevel` rather than by equality.
 */
export const ACCESS_LEVELS = [
    "List",
    "Read",
    "Write",
    "Tagging",
    "Permissions management",
    "Unknown",
];

/** @param {object} action @param {string} level */
export function hasAccessLevel(action, level) {
    return (action.access_levels || []).includes(level);
}

/** A statement in its editable form, before rendering to JSON. */
export function emptyStatement() {
    return {
        sid: "",
        effect: "Allow",
        servicePrefix: "",
        actions: [],
        wildcardAction: false,
        principalType: "AWS",
        principalValues: "",
        anyResource: true,
        resources: [],
        conditions: [],
    };
}

// --- action capability helpers ------------------------------------------------

/** True if the action can be scoped to a specific ARN at all. */
export function canScope(action) {
    return (action.resource_types || []).some((rt) => rt.resource_type !== "");
}

/** True if the SAR marks a resource type as required for this action. */
export function mustScope(action) {
    return (action.resource_types || []).some(
        (rt) => rt.required && rt.resource_type !== "",
    );
}

/**
 * Resource type names a set of actions can be scoped to, with whether any
 * selecting action requires them.
 * @returns {Array<{resource_type: string, required: boolean}>}
 */
export function resourceTypesFor(service, actionNames) {
    const selected = new Set(actionNames);
    /** @type {Map<string, boolean>} */
    const types = new Map();

    for (const action of service.actions || []) {
        if (!selected.has(action.name)) continue;
        for (const rt of action.resource_types || []) {
            if (!rt.resource_type) continue;
            types.set(rt.resource_type, (types.get(rt.resource_type) || false) || rt.required);
        }
    }

    return [...types.entries()]
        .map(([resource_type, required]) => ({ resource_type, required }))
        .sort((a, b) => a.resource_type.localeCompare(b.resource_type));
}

/** Actions that the selected actions declare as prerequisites. */
export function dependentActionsFor(service, actionNames) {
    const selected = new Set(actionNames);
    const prefixed = new Set(actionNames.map((n) => `${service.prefix}:${n}`));
    const missing = new Set();

    for (const action of service.actions || []) {
        if (!selected.has(action.name)) continue;
        for (const rt of action.resource_types || []) {
            for (const dep of rt.dependent_actions || []) {
                if (!prefixed.has(dep)) missing.add(dep);
            }
        }
    }

    return [...missing].sort();
}

// --- resource-scope splitting -------------------------------------------------

/** Appended to the Sid of the statement carrying the wildcard-only actions. */
const UNSCOPED_SID_SUFFIX = "AnyResource";

/**
 * Split a statement whose actions disagree about resource scoping.
 *
 * An action with no resource type only ever matches `Resource: "*"`. Emitting
 * it alongside specific ARNs produces a grant that silently never applies --
 * IAM accepts the policy, the permission just never takes effect. Splitting is
 * the only way to express both halves correctly, so the generator does it
 * rather than handing over a document it knows is dead.
 *
 * @returns {Array<object>} one statement, or two
 */
function splitByScope(statement, getService) {
    // Nothing to split: already unscoped, or granting the whole service.
    if (statement.anyResource || statement.wildcardAction) return [statement];

    const service = getService?.(statement.servicePrefix);
    if (!service) return [statement];

    const selected = new Set(statement.actions);
    const chosen = (service.actions || []).filter((a) => selected.has(a.name));
    const wildcardOnly = chosen.filter((a) => !canScope(a));

    if (wildcardOnly.length === 0) return [statement];

    const unscoped = {
        ...statement,
        actions: wildcardOnly.map((a) => a.name),
        anyResource: true,
        resources: [],
    };

    const scopeable = chosen.filter((a) => canScope(a));

    // Every action is wildcard-only, so the ARNs cannot apply to anything.
    if (scopeable.length === 0) return [unscoped];

    return [
        // The scoped half keeps the original position and Sid.
        { ...statement, actions: scopeable.map((a) => a.name) },
        { ...unscoped, sid: statement.sid ? `${statement.sid}${UNSCOPED_SID_SUFFIX}` : "" },
    ];
}

/**
 * The statements as they will actually be emitted.
 *
 * Exported so the UI can tell the user how many statements a policy will have
 * before it renders one.
 */
export function resolveStatements(statements, getService) {
    return statements.flatMap((statement) => splitByScope(statement, getService));
}

// --- document construction ----------------------------------------------------

function sanitizeSid(sid) {
    return (sid || "").replace(/[^A-Za-z0-9]/g, "");
}

function splitValues(raw) {
    return (raw || "")
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

/** Single-element arrays render as bare strings, matching the IAM console. */
function collapse(values) {
    return values.length === 1 ? values[0] : values;
}

function buildPrincipal(statement) {
    if (statement.principalType === "*") {
        return "*";
    }

    const values = splitValues(statement.principalValues);
    if (values.length === 0) {
        return null;
    }

    return { [statement.principalType]: collapse(values) };
}

function buildConditions(statement) {
    /** @type {Record<string, Record<string, string|Array<string>>>} */
    const conditions = {};

    for (const row of statement.conditions) {
        if (!row.key || !row.operator) continue;
        const values = splitValues(row.value);
        if (values.length === 0) continue;

        conditions[row.operator] ??= {};
        conditions[row.operator][row.key] = collapse(values);
    }

    return Object.keys(conditions).length > 0 ? conditions : null;
}

function buildActions(statement) {
    if (!statement.servicePrefix) return [];
    if (statement.wildcardAction) return [`${statement.servicePrefix}:*`];

    return statement.actions
        .map((name) => `${statement.servicePrefix}:${name}`)
        .sort();
}

function buildResources(statement, context) {
    if (statement.anyResource) return ["*"];

    return statement.resources
        .map((r) => renderArn(r.template, context, r.values))
        .filter(Boolean);
}

/**
 * Render the editable statements into an IAM policy document.
 * @param {string} policyTypeKey
 * @param {Array<object>} statements
 * @param {object} context  {partition, region, account}
 * @param {(prefix: string) => object|undefined} [getService]  omit to skip
 *        resource-scope splitting
 * @returns {object}
 */
export function buildPolicy(policyTypeKey, statements, context, getService) {
    const spec = POLICY_TYPES[policyTypeKey] || POLICY_TYPES.IAMPolicy;

    const rendered = resolveStatements(statements, getService).map((statement) => {
        /** @type {Record<string, unknown>} */
        const out = {};

        const sid = sanitizeSid(statement.sid);
        if (sid) out.Sid = sid;

        out.Effect = statement.effect;

        if (spec.principal !== "none") {
            const principal = buildPrincipal(statement);
            if (principal) out.Principal = principal;
        }

        const actions = buildActions(statement);
        if (actions.length > 0) out.Action = collapse(actions);

        if (spec.resource !== "none") {
            const resources = buildResources(statement, context);
            if (resources.length > 0) out.Resource = collapse(resources);
        }

        const conditions = buildConditions(statement);
        if (conditions) out.Condition = conditions;

        return out;
    });

    return { Version: "2012-10-17", Statement: rendered };
}

// --- validation ---------------------------------------------------------------

/**
 * @typedef {{level: "error"|"warning"|"info", message: string,
 *            statement: number, fix?: {label: string, actions: Array<string>}}} Finding
 */

/**
 * Check the statements for the mistakes this dataset can actually catch.
 * @param {string} policyTypeKey
 * @param {Array<object>} statements
 * @param {(prefix: string) => object|undefined} getService
 * @returns {Array<Finding>}
 */
export function validate(policyTypeKey, statements, getService) {
    const spec = POLICY_TYPES[policyTypeKey] || POLICY_TYPES.IAMPolicy;
    /** @type {Array<Finding>} */
    const findings = [];

    // What the document as a whole allows, for the dependent-action check below.
    // A Deny does not satisfy a prerequisite, so only Allow statements count.
    const granted = new Set();
    const grantedAll = new Set();
    for (const s of statements) {
        if (s.effect !== "Allow" || !s.servicePrefix) continue;
        if (s.wildcardAction) grantedAll.add(s.servicePrefix);
        for (const name of s.actions) granted.add(`${s.servicePrefix}:${name}`);
    }

    statements.forEach((statement, index) => {
        const add = (level, message, fix) =>
            findings.push({ level, message, statement: index, fix });

        if (!statement.servicePrefix) {
            add("error", "No service selected.");
            return;
        }

        if (!statement.wildcardAction && statement.actions.length === 0) {
            add("error", "No actions selected.");
            return;
        }

        const service = getService(statement.servicePrefix);
        if (!service) return;

        if (spec.principal === "required" && !buildPrincipal(statement)) {
            add("error", `A ${spec.name} requires a Principal.`);
        }

        if (
            statement.principalType === "*" &&
            statement.effect === "Allow" &&
            statement.conditions.length === 0 &&
            spec.principal !== "none"
        ) {
            add(
                "warning",
                "Principal is \"*\" with no Condition — this grants public access.",
            );
        }

        if (statement.wildcardAction) {
            add(
                "warning",
                `${statement.servicePrefix}:* grants all ` +
                    `${service.actions.length} actions in this service.`,
            );
        }

        const selected = new Set(statement.actions);
        const chosen = (service.actions || []).filter((a) => selected.has(a.name));

        const wildcardOnly = chosen.filter((a) => !canScope(a));
        const anyScopeable = chosen.filter((a) => canScope(a));
        const shouldScope = chosen.filter((a) => mustScope(a));

        // buildPolicy splits these apart rather than emitting a dead grant, so
        // these findings describe what it did, not a problem left for the user.
        if (!statement.anyResource && wildcardOnly.length > 0) {
            if (anyScopeable.length === 0) {
                add(
                    "warning",
                    `${listActions(wildcardOnly)} ` +
                        `${verb(wildcardOnly, "has", "have")} no resource-level ` +
                        'permissions, so this statement is emitted with ' +
                        'Resource: "*" and the ARNs above are not used.',
                );
            } else {
                add(
                    "info",
                    `${listActions(wildcardOnly)} only ` +
                        `${verb(wildcardOnly, "matches", "match")} Resource: "*", ` +
                        `so ${verb(wildcardOnly, "it was", "they were")} split into ` +
                        "a separate statement. The rest keep the ARNs you specified.",
                );
            }
        }

        if (statement.anyResource && shouldScope.length > 0 && !statement.wildcardAction) {
            add(
                "warning",
                `${listActions(shouldScope)} ${verb(shouldScope, "supports", "support")} ` +
                    'resource-level permissions — Resource: "*" is broader than necessary.',
            );
        }

        const permissionActions = chosen.filter((a) =>
            hasAccessLevel(a, "Permissions management"),
        );
        if (permissionActions.length > 0 && statement.effect === "Allow") {
            add(
                "warning",
                `${listActions(permissionActions)} can modify permissions — ` +
                    `${verb(permissionActions, "this allows", "these allow")} ` +
                    "privilege escalation.",
            );
        }

        // Satisfied anywhere in the document, not just in this statement: the
        // fix puts a cross-service dependency in its own statement, so scoping
        // the check to one statement leaves the finding standing forever and
        // every further click appends another copy of that statement.
        const missingDeps = dependentActionsFor(service, statement.actions).filter(
            (dep) => !granted.has(dep) && !grantedAll.has(dep.slice(0, dep.indexOf(":"))),
        );
        if (missingDeps.length > 0) {
            add(
                "info",
                `AWS documents ${missingDeps.length} dependent ` +
                    `action${missingDeps.length === 1 ? "" : "s"} for this ` +
                    `selection: ${missingDeps.join(", ")}.`,
                { label: "Add dependent actions", actions: missingDeps },
            );
        }
    });

    if (statements.length === 0) {
        findings.push({
            level: "error",
            message: "Add at least one statement.",
            statement: -1,
        });
    }

    return findings;
}

function listActions(actions) {
    const names = actions.map((a) => a.name);
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Agree with the subject built by listActions, which may name one action. */
function verb(actions, singular, plural) {
    return actions.length === 1 ? singular : plural;
}
