/**
 * Fuzzy-match ranking, exercised against the real service index.
 *
 * The scoring half of combobox.js is DOM-free; the widget itself is not covered.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { _internal } from "../site/js/combobox.js";

const { score } = _internal;

const index = JSON.parse(
    readFileSync(new URL("../site/data/index.json", import.meta.url)),
);

const ITEMS = index.map((entry) => ({
    key: entry.prefix,
    label: `${entry.service_name} (${entry.prefix})`,
}));

/** Ranked matches for a query, best first. */
function search(query) {
    const needle = query.trim().toLowerCase();
    return ITEMS.map((item) => ({ item, s: score(item, needle) }))
        .filter((row) => row.s > 0)
        .sort((a, b) => b.s - a.s || a.item.label.length - b.item.label.length)
        .map((row) => row.item.key);
}

const top = (query) => search(query)[0];

test("an exact prefix wins outright", () => {
    assert.equal(top("s3"), "s3");
    assert.equal(top("ec2"), "ec2");
    assert.equal(top("iam"), "iam");
});

test("a service is findable by display name", () => {
    assert.equal(top("lambda"), "lambda");
    assert.ok(search("dynamodb").includes("dynamodb"));
});

test("a mid-name word matches without typing the vendor prefix", () => {
    // "Amazon Elastic Kubernetes Service" — nobody types "amazon e".
    assert.ok(search("kubernetes").includes("eks"), "kubernetes finds eks");
    assert.ok(search("step functions").includes("states"), "step functions finds states");
});

test("subsequence matching tolerates gaps", () => {
    assert.ok(score({ key: "eks", label: "amazon elastic kubernetes service (eks)" }, "elastick") > 0);
});

test("a non-matching query returns nothing", () => {
    assert.equal(search("zzzqqqxxnotaservice").length, 0);
});

test("prefix matches outrank incidental substring matches", () => {
    // Many labels contain "sts" somewhere; the service itself must come first.
    assert.equal(top("sts"), "sts");
});

test("every service is reachable by its own prefix", () => {
    const unreachable = ITEMS.filter((item) => !search(item.key).includes(item.key));
    assert.deepEqual(unreachable.map((i) => i.key), [], "all prefixes self-match");
});

test("scores are stable and positive for self-lookup", () => {
    for (const item of ITEMS.slice(0, 50)) {
        assert.ok(score(item, item.key.toLowerCase()) > 0, item.key);
    }
});
