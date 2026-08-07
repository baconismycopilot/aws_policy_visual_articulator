/**
 * Tests for the policy engine, run against the real generated shards.
 *
 * policy.js and arn.js are deliberately DOM-free so they can be exercised here
 * with `node --test`; the rendering modules are not covered.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    buildPolicy,
    canScope,
    dependentActionsFor,
    emptyStatement,
    hasAccessLevel,
    mustScope,
    resolveStatements,
    resourceTypesFor,
    validate,
} from "../site/js/policy.js";
import { placeholders, renderArn, userPlaceholders } from "../site/js/arn.js";

const CONTEXT = { partition: "aws", region: "us-east-1", account: "111122223333" };

const shard = (prefix) =>
    JSON.parse(readFileSync(new URL(`../site/data/svc/${prefix}.json`, import.meta.url)));

const s3 = shard("s3");
// s3 documents no dependent actions; access-analyzer does, and the fix path
// needs a service whose dependents live in *another* service (iam:PassRole).
const analyzer = shard("access-analyzer");
const SHARDS = { s3, "access-analyzer": analyzer };
const getService = (prefix) => SHARDS[prefix];

/**
 * Pick fixtures out of the live shard rather than hardcoding action names —
 * AWS moves actions between these categories, and a hardcoded name turns an
 * upstream reclassification into a spurious test failure.
 */
const pick = (predicate) => {
    const action = s3.actions.find(predicate);
    assert.ok(action, "no matching action in the s3 shard");
    return action;
};

const REQUIRES_RESOURCE = pick(mustScope);
const WILDCARD_ONLY = pick((a) => !canScope(a));
const PERMISSIONS_MGMT = pick((a) => hasAccessLevel(a, "Permissions management"));

function statement(overrides = {}) {
    return { ...emptyStatement(), servicePrefix: "s3", ...overrides };
}

// --- ARN templates ------------------------------------------------------------

test("placeholders are extracted in order without duplicates", () => {
    const template = "arn:${Partition}:s3:::${BucketName}/${BucketName}";
    assert.deepEqual(placeholders(template), ["Partition", "BucketName"]);
    assert.deepEqual(userPlaceholders(template), ["BucketName"]);
});

test("context fills partition, region and account", () => {
    const arn = renderArn(
        "arn:${Partition}:ec2:${Region}:${Account}:instance/${InstanceId}",
        CONTEXT,
        { InstanceId: "i-abc" },
    );
    assert.equal(arn, "arn:aws:ec2:us-east-1:111122223333:instance/i-abc");
});

test("unfilled placeholders become wildcards", () => {
    const arn = renderArn("arn:${Partition}:s3:::${BucketName}/${ObjectName}", CONTEXT, {
        BucketName: "my-bucket",
    });
    assert.equal(arn, "arn:aws:s3:::my-bucket/*");
});

// --- action capability from real data -----------------------------------------

test("an action with a required resource type both can and must be scoped", () => {
    assert.ok(canScope(REQUIRES_RESOURCE));
    assert.ok(mustScope(REQUIRES_RESOURCE));
});

test("an action with no named resource type cannot be scoped", () => {
    assert.ok(!canScope(WILDCARD_ONLY));
    assert.ok(!mustScope(WILDCARD_ONLY));
});

test("access levels are multi-valued", () => {
    // "Permissions management, Write" is one upstream string, two levels.
    const multi = s3.actions.find((a) => a.access_levels.length > 1);
    assert.ok(multi, "s3 has actions carrying more than one access level");
    assert.ok(hasAccessLevel(multi, "Write"));
});

test("resource types for a selection are deduplicated and marked required", () => {
    const types = resourceTypesFor(s3, [REQUIRES_RESOURCE.name]);
    assert.ok(types.length > 0, "at least one resource type is offered");
    assert.ok(types.some((t) => t.required), "the required flag survives");

    const names = types.map((t) => t.resource_type);
    assert.equal(new Set(names).size, names.length, "no duplicate resource types");
});

test("dependent actions are reported fully qualified", () => {
    const deps = dependentActionsFor(analyzer, ["StartPolicyGeneration"]);
    assert.ok(deps.includes("iam:PassRole"), deps.join(", "));
    assert.ok(deps.every((d) => d.includes(":")), "dependents carry a service prefix");
});

test("an action is not reported as its own dependency", () => {
    const all = analyzer.actions.map((a) => a.name);
    const deps = dependentActionsFor(analyzer, all);
    const selected = new Set(all.map((n) => `access-analyzer:${n}`));

    assert.ok(
        deps.every((d) => !selected.has(d)),
        "already-selected actions are filtered out of the dependency list",
    );
});

// --- document construction ----------------------------------------------------

test("a scoped identity policy renders as expected", () => {
    const policy = buildPolicy("IAMPolicy", [
        statement({
            sid: "Read objects",
            actions: ["GetObject"],
            anyResource: false,
            resources: [{
                resourceType: "object",
                template: "arn:${Partition}:s3:::${BucketName}/${ObjectName}",
                values: { BucketName: "my-bucket" },
            }],
            conditions: [
                { key: "s3:ResourceAccount", operator: "StringEquals", value: "111122223333" },
            ],
        }),
    ], CONTEXT);

    assert.deepEqual(policy, {
        Version: "2012-10-17",
        Statement: [{
            Sid: "Readobjects",
            Effect: "Allow",
            Action: "s3:GetObject",
            Resource: "arn:aws:s3:::my-bucket/*",
            Condition: { StringEquals: { "s3:ResourceAccount": "111122223333" } },
        }],
    });
});

test("identity policies never emit a Principal", () => {
    const policy = buildPolicy("IAMPolicy", [
        statement({ actions: ["GetObject"], principalValues: "arn:aws:iam::1:root" }),
    ], CONTEXT);
    assert.ok(!("Principal" in policy.Statement[0]));
});

test("a bucket policy emits the Principal", () => {
    const policy = buildPolicy("S3Policy", [
        statement({
            actions: ["GetObject"],
            principalType: "AWS",
            principalValues: "arn:aws:iam::444455556666:root",
        }),
    ], CONTEXT);
    assert.deepEqual(policy.Statement[0].Principal, { AWS: "arn:aws:iam::444455556666:root" });
});

test("a trust policy has a Principal and no Resource", () => {
    const policy = buildPolicy("TrustPolicy", [
        statement({
            servicePrefix: "sts",
            actions: ["AssumeRole"],
            principalType: "Service",
            principalValues: "lambda.amazonaws.com",
        }),
    ], CONTEXT);

    const only = policy.Statement[0];
    assert.equal(only.Action, "sts:AssumeRole");
    assert.deepEqual(only.Principal, { Service: "lambda.amazonaws.com" });
    assert.ok(!("Resource" in only), "trust policies carry no Resource block");
});

test("multiple values collapse to a string and expand to an array", () => {
    const one = buildPolicy("S3Policy", [
        statement({ actions: ["GetObject"], principalValues: "a" }),
    ], CONTEXT);
    const two = buildPolicy("S3Policy", [
        statement({ actions: ["GetObject"], principalValues: "a, b" }),
    ], CONTEXT);

    assert.equal(one.Statement[0].Principal.AWS, "a");
    assert.deepEqual(two.Statement[0].Principal.AWS, ["a", "b"]);
});

test("wildcard actions render as service:*", () => {
    const policy = buildPolicy("IAMPolicy", [
        statement({ wildcardAction: true }),
    ], CONTEXT);
    assert.equal(policy.Statement[0].Action, "s3:*");
});

// --- validation ---------------------------------------------------------------

const levels = (findings, level) => findings.filter((f) => f.level === level);
const messages = (findings) => findings.map((f) => f.message).join(" | ");

test("an all-wildcard-only statement is emitted with Resource:* and says so", () => {
    const stmt = statement({
        actions: [WILDCARD_ONLY.name],
        anyResource: false,
        resources: [{
            resourceType: "bucket",
            template: "arn:${Partition}:s3:::${BucketName}",
            values: { BucketName: "my-bucket" },
        }],
    });

    // The ARNs cannot apply to any of these actions, so they are dropped.
    const policy = buildPolicy("IAMPolicy", [stmt], CONTEXT, getService);
    assert.equal(policy.Statement.length, 1);
    assert.equal(policy.Statement[0].Resource, "*");

    const findings = validate("IAMPolicy", [stmt], getService);
    assert.ok(
        levels(findings, "warning").some((f) => f.message.includes("not used")),
        messages(findings),
    );
});

test("a scopeable action left at Resource:* is a warning, not an error", () => {
    const findings = validate("IAMPolicy", [
        statement({ actions: [REQUIRES_RESOURCE.name], anyResource: true }),
    ], getService);

    assert.equal(levels(findings, "error").length, 0, messages(findings));
    assert.ok(
        levels(findings, "warning").some((f) => f.message.includes("broader than necessary")),
        messages(findings),
    );
});

test("a mixed statement is split, and the split is reported", () => {
    const stmt = statement({
        actions: [REQUIRES_RESOURCE.name, WILDCARD_ONLY.name],
        anyResource: false,
        resources: [{
            resourceType: "bucket",
            template: "arn:${Partition}:s3:::${BucketName}",
            values: { BucketName: "my-bucket" },
        }],
    });

    const policy = buildPolicy("IAMPolicy", [stmt], CONTEXT, getService);
    assert.equal(policy.Statement.length, 2, JSON.stringify(policy, null, 2));

    const [scoped, unscoped] = policy.Statement;
    assert.equal(scoped.Resource, "arn:aws:s3:::my-bucket");
    assert.equal([scoped.Action].flat().join(), `s3:${REQUIRES_RESOURCE.name}`);
    assert.equal(unscoped.Resource, "*");
    assert.equal([unscoped.Action].flat().join(), `s3:${WILDCARD_ONLY.name}`);

    const findings = validate("IAMPolicy", [stmt], getService);
    assert.ok(
        levels(findings, "info").some((f) => f.message.includes("separate statement")),
        messages(findings),
    );
});

test("splitting is skipped when the statement is already unscoped", () => {
    const stmt = statement({
        actions: [REQUIRES_RESOURCE.name, WILDCARD_ONLY.name],
        anyResource: true,
    });

    const policy = buildPolicy("IAMPolicy", [stmt], CONTEXT, getService);
    assert.equal(policy.Statement.length, 1, "Resource:* needs no split");
});

test("splitting is skipped for a service:* wildcard action", () => {
    const stmt = statement({ wildcardAction: true, anyResource: false });
    const policy = buildPolicy("IAMPolicy", [stmt], CONTEXT, getService);

    assert.equal(policy.Statement.length, 1);
    assert.equal(policy.Statement[0].Action, "s3:*");
});

test("the split statement derives its Sid from the original", () => {
    const stmt = statement({
        sid: "ClusterAdmin",
        actions: [REQUIRES_RESOURCE.name, WILDCARD_ONLY.name],
        anyResource: false,
        resources: [{
            resourceType: "bucket",
            template: "arn:${Partition}:s3:::${BucketName}",
            values: { BucketName: "b" },
        }],
    });

    const [scoped, unscoped] = buildPolicy("IAMPolicy", [stmt], CONTEXT, getService).Statement;

    assert.equal(scoped.Sid, "ClusterAdmin", "the scoped half keeps the original Sid");
    assert.equal(unscoped.Sid, "ClusterAdminAnyResource");
});

test("no service lookup means no splitting", () => {
    // buildPolicy is used without a lookup in a few places; it must stay inert.
    const stmt = statement({
        actions: [REQUIRES_RESOURCE.name, WILDCARD_ONLY.name],
        anyResource: false,
        resources: [{ resourceType: "bucket", template: "arn:${Partition}:s3:::x", values: {} }],
    });

    assert.equal(buildPolicy("IAMPolicy", [stmt], CONTEXT).Statement.length, 1);
});

test("resolveStatements reports the real statement count", () => {
    const stmt = statement({
        actions: [REQUIRES_RESOURCE.name, WILDCARD_ONLY.name],
        anyResource: false,
        resources: [{ resourceType: "bucket", template: "arn:${Partition}:s3:::x", values: {} }],
    });

    assert.equal(resolveStatements([stmt], getService).length, 2);
    assert.equal(resolveStatements([stmt], undefined).length, 1);
});

test("permissions-management actions are flagged", () => {
    const findings = validate("IAMPolicy", [
        statement({ actions: [PERMISSIONS_MGMT.name], anyResource: true }),
    ], getService);

    assert.ok(
        levels(findings, "warning").some((f) => f.message.includes("modify permissions")),
        messages(findings),
    );
});

test("a resource policy without a Principal is an error", () => {
    const findings = validate("S3Policy", [
        statement({ actions: ["GetObject"], principalValues: "" }),
    ], getService);

    assert.ok(
        levels(findings, "error").some((f) => f.message.includes("requires a Principal")),
        messages(findings),
    );
});

test("public access without a condition is flagged", () => {
    const findings = validate("S3Policy", [
        statement({ actions: ["GetObject"], principalType: "*" }),
    ], getService);

    assert.ok(
        levels(findings, "warning").some((f) => f.message.includes("public access")),
        messages(findings),
    );
});

test("adding a condition clears the public-access warning", () => {
    const findings = validate("S3Policy", [
        statement({
            actions: ["GetObject"],
            principalType: "*",
            conditions: [{ key: "aws:SourceIp", operator: "IpAddress", value: "10.0.0.0/8" }],
        }),
    ], getService);

    assert.ok(
        !levels(findings, "warning").some((f) => f.message.includes("public access")),
        messages(findings),
    );
});

test("an empty statement reports missing actions", () => {
    const findings = validate("IAMPolicy", [statement({ actions: [] })], getService);
    assert.ok(levels(findings, "error").some((f) => f.message.includes("No actions")));
});

test("the dependent-action finding carries an applicable fix", () => {
    const findings = validate("IAMPolicy", [
        statement({
            servicePrefix: "access-analyzer",
            actions: ["StartPolicyGeneration"],
            anyResource: true,
        }),
    ], getService);

    const fixable = findings.find((f) => f.fix);
    assert.ok(fixable, messages(findings));
    assert.deepEqual(fixable.fix.actions, ["iam:PassRole"]);
});

test("a dependent action granted by another statement clears the finding", () => {
    // What the fix itself produces. If the check stays inside one statement the
    // finding never clears, and clicking again appends another iam statement --
    // duplicate Sids, which AWS rejects outright.
    const findings = validate("IAMPolicy", [
        statement({ servicePrefix: "access-analyzer", actions: ["StartPolicyGeneration"] }),
        statement({ servicePrefix: "iam", sid: "Dependenciesiam", actions: ["PassRole"] }),
    ], getService);

    assert.equal(findings.filter((f) => f.fix).length, 0, messages(findings));
});

test("a dependent action satisfied only by a Deny still counts as missing", () => {
    const findings = validate("IAMPolicy", [
        statement({ servicePrefix: "access-analyzer", actions: ["StartPolicyGeneration"] }),
        statement({ servicePrefix: "iam", effect: "Deny", actions: ["PassRole"] }),
    ], getService);

    const fixable = findings.find((f) => f.fix);
    assert.ok(fixable, messages(findings));
    assert.deepEqual(fixable.fix.actions, ["iam:PassRole"]);
});

// --- duplicate Sids -----------------------------------------------------------

const sidErrors = (statements) =>
    validate("IAMPolicy", statements, getService).filter(
        (f) => f.level === "error" && f.message.startsWith("Sid "),
    );

test("two statements sharing a Sid are an error", () => {
    const dupes = sidErrors([statement({ sid: "Foo" }), statement({ sid: "Foo" })]);

    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].statement, 1, "reported against the later statement");
    assert.match(dupes[0].message, /already used by statement 1/);
});

test("every statement after the first duplicate is flagged", () => {
    const dupes = sidErrors([
        statement({ sid: "X" }),
        statement({ sid: "X" }),
        statement({ sid: "X" }),
    ]);

    assert.deepEqual(dupes.map((f) => f.statement), [1, 2]);
});

test("Sids differing only in punctuation collide once emitted", () => {
    // sanitizeSid strips everything outside [A-Za-z0-9], so these are one Sid by
    // the time they reach the document even though the fields differ. Case is
    // preserved, so "Read objects" would *not* collide -- only the space goes.
    assert.equal(sidErrors([statement({ sid: "Read Objects" }), statement({ sid: "ReadObjects" })]).length, 1);
    assert.equal(sidErrors([statement({ sid: "Read objects" }), statement({ sid: "ReadObjects" })]).length, 0);
});

test("empty Sids do not collide with each other", () => {
    // An empty Sid is omitted from the document, so any number of them is fine.
    assert.deepEqual(sidErrors([statement({}), statement({}), statement({})]), []);
});

test("the Sid a resource-scope split invents is checked too", () => {
    // A split statement emits both "Foo" and "FooAnyResource". On its own that
    // is two distinct Sids; against a hand-written "FooAnyResource" it is not,
    // and nothing in the editable statements shows the clash.
    const splitting = statement({
        sid: "Foo",
        actions: [REQUIRES_RESOURCE.name, WILDCARD_ONLY.name],
        anyResource: false,
        resources: [{ template: "arn:aws:s3:::bucket/*", values: {} }],
    });

    assert.deepEqual(sidErrors([splitting]), [], "a split alone invents no clash");

    const clash = sidErrors([splitting, statement({ sid: "FooAnyResource" })]);
    assert.equal(clash.length, 1);
    assert.match(clash[0].message, /"FooAnyResource"/);
});

test("a service wildcard covers the dependent actions it grants", () => {
    const findings = validate("IAMPolicy", [
        statement({ servicePrefix: "access-analyzer", actions: ["StartPolicyGeneration"] }),
        statement({ servicePrefix: "iam", wildcardAction: true, actions: [] }),
    ], getService);

    assert.equal(findings.filter((f) => f.fix).length, 0, messages(findings));
});

// --- context propagation ------------------------------------------------------

test("the document reflects later mutations of the shared context object", () => {
    // app.js keeps one context object and mutates it in place; buildPolicy must
    // read through to it rather than capture values at construction time.
    const ctx = { partition: "aws", region: "us-east-1", account: "" };
    const stmt = statement({
        actions: [REQUIRES_RESOURCE.name],
        anyResource: false,
        resources: [{
            resourceType: "bucket",
            template: "arn:${Partition}:s3:${Region}:${Account}:bucket/${BucketName}",
            values: { BucketName: "my-bucket" },
        }],
    });

    const resource = () => buildPolicy("IAMPolicy", [stmt], ctx).Statement[0].Resource;

    assert.equal(resource(), "arn:aws:s3:us-east-1:*:bucket/my-bucket");

    ctx.account = "111122223333";
    assert.equal(resource(), "arn:aws:s3:us-east-1:111122223333:bucket/my-bucket");

    ctx.region = "eu-west-2";
    ctx.partition = "aws-cn";
    assert.equal(resource(), "arn:aws-cn:s3:eu-west-2:111122223333:bucket/my-bucket");
});

test("the ARN preview formula matches the document's Resource entries", () => {
    // The grey preview under each resource row is rendered independently of
    // buildPolicy. If the two ever diverge, the preview lies about the output.
    const ctx = { partition: "aws", region: "eu-west-2", account: "111122223333" };
    const rows = [
        {
            resourceType: "bucket",
            template: "arn:${Partition}:s3:::${BucketName}",
            values: { BucketName: "logs" },
        },
        {
            resourceType: "object",
            template: "arn:${Partition}:s3:::${BucketName}/${ObjectName}",
            values: { BucketName: "logs" },
        },
    ];
    const stmt = statement({
        actions: [REQUIRES_RESOURCE.name],
        anyResource: false,
        resources: rows,
    });

    const previews = rows.map((r) => renderArn(r.template, ctx, r.values));
    const resources = buildPolicy("IAMPolicy", [stmt], ctx).Statement[0].Resource;

    assert.deepEqual(previews, resources);
});
