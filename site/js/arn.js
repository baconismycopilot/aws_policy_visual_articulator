"use strict";

/**
 * ARN template handling.
 *
 * The Service Authorization Reference gives ARN formats as templates with
 * placeholders, e.g. `arn:${Partition}:s3:::${BucketName}/${ObjectName}`.
 * We parse the placeholders out so the UI can render one input per segment,
 * prefilling the three that come from the account context.
 */

const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

/** Placeholders that come from the context bar rather than per-ARN input. */
const CONTEXT_KEYS = {
    Partition: "partition",
    Region: "region",
    Account: "account",
};

/**
 * Ordered, de-duplicated placeholder names in a template.
 * @param {string} template
 * @returns {Array<string>}
 */
export function placeholders(template) {
    const found = [];
    for (const match of template.matchAll(PLACEHOLDER)) {
        if (!found.includes(match[1])) {
            found.push(match[1]);
        }
    }
    return found;
}

/**
 * Placeholders the user must fill in — everything not supplied by the context.
 * @param {string} template
 * @returns {Array<string>}
 */
export function userPlaceholders(template) {
    return placeholders(template).filter((name) => !(name in CONTEXT_KEYS));
}

/**
 * Render a template into a concrete ARN.
 *
 * Anything left unfilled becomes `*`, which is what a user leaving the box
 * empty almost always means, and keeps the live preview valid at all times.
 *
 * @param {string} template
 * @param {object} context  {partition, region, account}
 * @param {object} values   placeholder name -> user-entered value
 * @returns {string}
 */
export function renderArn(template, context, values = {}) {
    return template.replace(PLACEHOLDER, (_match, name) => {
        const contextField = CONTEXT_KEYS[name];
        if (contextField) {
            return (context[contextField] || "").trim() || "*";
        }
        return (values[name] || "").trim() || "*";
    });
}

/**
 * True if an ARN is fully wildcarded in the segments that matter — i.e. it
 * grants no more narrowly than `"*"` would, so scoping it bought nothing.
 * @param {string} arn
 * @returns {boolean}
 */
export function isEffectivelyWildcard(arn) {
    const resourcePart = arn.split(":").slice(5).join(":");
    return resourcePart === "" || /^\*+$/.test(resourcePart.replace(/[/:]/g, ""));
}
