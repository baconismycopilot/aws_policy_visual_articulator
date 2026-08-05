"use strict";

/**
 * Loads the sharded IAM data. The index is ~6 KB gzipped and fetched once;
 * per-service shards are ~1 KB median and fetched lazily on selection, then
 * memoized for the session.
 */

const DATA_ROOT = "./data";

/** @type {Map<string, object>} */
const serviceCache = new Map();

/** @type {object|null} */
let globalData = null;

/** @type {Array<object>|null} */
let serviceIndex = null;

async function getJSON(path) {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`${path} -> HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * Condition operators, global condition keys, policy types, partitions.
 * @returns {Promise<object>}
 */
export async function loadGlobal() {
    if (globalData === null) {
        globalData = await getJSON(`${DATA_ROOT}/global.json`);
    }
    return globalData;
}

/**
 * Every service: prefix, display name, action count. Sorted by display name.
 * @returns {Promise<Array<object>>}
 */
export async function loadIndex() {
    if (serviceIndex === null) {
        serviceIndex = await getJSON(`${DATA_ROOT}/index.json`);
    }
    return serviceIndex;
}

/**
 * One service shard, with full action / resource / condition detail.
 * @param {string} prefix
 * @returns {Promise<object>}
 */
export async function loadService(prefix) {
    if (!serviceCache.has(prefix)) {
        serviceCache.set(prefix, await getJSON(`${DATA_ROOT}/svc/${prefix}.json`));
    }
    return serviceCache.get(prefix);
}

/**
 * Synchronous access to an already-loaded shard, for render paths that cannot
 * await. Returns undefined if the shard has not been fetched yet.
 * @param {string} prefix
 * @returns {object|undefined}
 */
export function peekService(prefix) {
    return serviceCache.get(prefix);
}

/**
 * Every condition key that could legally apply to a set of actions: the
 * service's own keys, the per-action keys, and the AWS global keys.
 * @param {object} service
 * @param {Array<string>} actionNames
 * @returns {Array<string>}
 */
export function conditionKeysFor(service, actionNames) {
    const keys = new Set(service.service_condition_keys || []);

    for (const condition of service.conditions || []) {
        keys.add(condition.condition);
    }

    const selected = new Set(actionNames);
    for (const action of service.actions || []) {
        if (!selected.has(action.name)) continue;
        for (const resourceType of action.resource_types || []) {
            for (const key of resourceType.condition_keys || []) {
                keys.add(key);
            }
        }
    }

    if (globalData) {
        for (const key of globalData.global_condition_keys || []) {
            keys.add(key);
        }
    }

    return [...keys].sort();
}
