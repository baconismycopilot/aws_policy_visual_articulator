/**
 * Render-layer tests: the wiring the pure-function suites cannot reach.
 *
 * Every bug found by hand in this project lived here — a handler not attached,
 * a re-render not triggered — and none of it was reachable without a DOM.
 * jsdom gives one in milliseconds; these run against the real index.html and
 * the real generated shards.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { byText, change, click, mousedown, settle, setupPage, type } from "./harness.mjs";

/**
 * Boot a tab. Modules hold module-level state, so each test imports them fresh
 * with a cache-busting query — otherwise tab two inherits tab one's DOM refs.
 */
let nonce = 0;
async function boot(which, context) {
    const page = setupPage();
    const bust = `?t=${nonce++}`;

    if (which === "browse") {
        const mod = await import(`../site/js/browse.js${bust}`);
        await mod.initBrowse();
        await settle();
        return { page, mod };
    }

    const mod = await import(`../site/js/generate.js${bust}`);
    await mod.initGenerate(context);
    await settle();
    return { page, mod };
}

/** Drive the combobox the way a user does: type, then commit an option. */
async function pickService(document, mountSelector, query) {
    const input = document.querySelector(`${mountSelector} input`);
    type(input, query);
    await settle();

    const option = document.querySelector(`${mountSelector} .combobox-option`);
    assert.ok(option, `no combobox option matched "${query}"`);
    mousedown(option);
    await settle();
    return option.textContent;
}

// --- Browse -------------------------------------------------------------------

test("browse: selecting a service renders its actions", async () => {
    const { page } = await boot("browse");
    const { document } = page;

    assert.ok(document.getElementById("browse-body").classList.contains("d-none"));

    await pickService(document, "#browse-service", "s3");

    assert.ok(!document.getElementById("browse-body").classList.contains("d-none"));
    assert.ok(
        document.querySelectorAll("#browse-actions tbody tr").length > 100,
        "s3 renders its full action table",
    );
    page.cleanup();
});

test("browse: action names link to the reference with the right anchor", async () => {
    const { page } = await boot("browse");
    const { document } = page;

    await pickService(document, "#browse-service", "s3");

    const link = document.querySelector("#browse-actions a.action-link");
    const href = link.getAttribute("href");

    assert.match(href, /\/list_s3\.html#list_s3-action-[A-Za-z]+$/, href);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener");
    page.cleanup();
});

test("browse: the removed sections are gone", async () => {
    const { page } = await boot("browse");
    const { document } = page;
    await pickService(document, "#browse-service", "s3");

    assert.equal(document.getElementById("browse-arns"), null);
    assert.equal(document.getElementById("browse-conditions"), null);
    page.cleanup();
});

test("browse: an access-level filter narrows the table", async () => {
    const { page } = await boot("browse");
    const { document } = page;
    await pickService(document, "#browse-service", "s3");

    const all = document.querySelectorAll("#browse-actions tbody tr").length;
    const chip = byText(document.getElementById("browse-levels"), "button", "Read");
    click(chip);
    await settle();

    const filtered = document.querySelectorAll("#browse-actions tbody tr").length;
    assert.ok(filtered > 0 && filtered < all, `${filtered} of ${all} after filtering`);
    page.cleanup();
});

test("browse: an action with two access levels shows two badges", async () => {
    const { page } = await boot("browse");
    const { document } = page;
    await pickService(document, "#browse-service", "s3");

    const rows = [...document.querySelectorAll("#browse-actions tbody tr")];
    const multi = rows.find((row) => row.querySelectorAll(".access-level").length > 1);

    assert.ok(multi, "s3 has actions carrying more than one access level");
    page.cleanup();
});

test("browse: the text filter matches descriptions as well as names", async () => {
    const { page } = await boot("browse");
    const { document } = page;
    await pickService(document, "#browse-service", "s3");

    type(document.getElementById("browse-filter"), "multipart");
    await settle();

    const rows = document.querySelectorAll("#browse-actions tbody tr");
    assert.ok(rows.length > 0 && rows.length < 50, `${rows.length} rows matched`);
    page.cleanup();
});

// --- Generate: the bug found by hand ------------------------------------------

test("generate: changing the account updates the ARN preview", async () => {
    // The regression. buildPolicy always read the live context, but the preview
    // under each resource row was written once at render time, so it froze.
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page, mod } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "ec2");

    const action = [...document.querySelectorAll(".action-picker .form-check-input")][0];
    change(Object.assign(action, { checked: true }));
    await settle();

    const specific = byText(document, "label", "Specific ARNs");
    const radio = document.getElementById(specific.getAttribute("for"));
    change(Object.assign(radio, { checked: true }));
    await settle();

    const preview = () => document.querySelector(".arn-preview")?.textContent ?? "";
    assert.match(preview(), /:\*:/, `account starts wildcarded: ${preview()}`);

    context.account = "111122223333";
    mod.refreshGenerate();
    await settle();

    assert.match(preview(), /111122223333/, `preview follows the context: ${preview()}`);
    page.cleanup();
});

test("generate: the preview and the JSON never disagree", async () => {
    const context = { partition: "aws", region: "us-east-1", account: "111122223333" };
    const { page, mod } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "ec2");

    const action = [...document.querySelectorAll(".action-picker .form-check-input")][0];
    change(Object.assign(action, { checked: true }));
    await settle();

    const specific = byText(document, "label", "Specific ARNs");
    const radio = document.getElementById(specific.getAttribute("for"));
    change(Object.assign(radio, { checked: true }));
    await settle();

    context.region = "eu-west-2";
    mod.refreshGenerate();
    await settle();

    const previews = [...document.querySelectorAll(".arn-preview")].map((n) => n.textContent);
    const policy = JSON.parse(document.getElementById("gen-output").textContent);
    const resources = [policy.Statement[0].Resource].flat();

    assert.deepEqual(previews, resources);
    page.cleanup();
});

// --- Generate: the re-render paths ---------------------------------------------

test("generate: removing a statement renumbers the rest and keeps their state", async () => {
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "ec2");

    click(document.getElementById("gen-add-statement"));
    await settle();
    assert.equal(document.querySelectorAll(".statement-card").length, 2);

    // Remove the first; the second must survive intact and become "Statement 1".
    const remove = document.querySelector(".statement-card .btn-outline-danger");
    click(remove);
    await settle();

    const cards = document.querySelectorAll(".statement-card");
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /Statement 1/);
    // The surviving card is the one that had no service selected.
    assert.equal(document.querySelectorAll(".action-picker").length, 0);
    page.cleanup();
});

test("generate: a resource-based policy type pins and locks the service", async () => {
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    const type = document.getElementById("gen-policy-type");
    type.value = "S3Policy";
    change(type);
    await settle();

    const input = document.querySelector("#gen-statements .combobox input");
    assert.ok(input.disabled, "the pinned picker is locked");
    assert.match(input.value, /Amazon S3/);
    assert.match(document.querySelector(".statement-card").textContent, /fixed by S3 Bucket Policy/);
    page.cleanup();
});

test("generate: a trust policy drops Resource and requires a Principal", async () => {
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    const type = document.getElementById("gen-policy-type");
    type.value = "TrustPolicy";
    change(type);
    await settle();

    const policy = JSON.parse(document.getElementById("gen-output").textContent);
    const statement = policy.Statement[0];

    assert.equal(statement.Action, "sts:AssumeRole");
    assert.ok(!("Resource" in statement), "trust policies carry no Resource");
    assert.match(
        document.getElementById("gen-findings").textContent,
        /requires a Principal/,
    );
    page.cleanup();
});

test("generate: the dependent-action fix adds a statement for another service", async () => {
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "access-analyzer");

    const box = [...document.querySelectorAll(".action-picker .form-check-input")].find(
        (input) => input.id.includes("StartPolicyGeneration"),
    );
    assert.ok(box, "StartPolicyGeneration is in the picker");
    change(Object.assign(box, { checked: true }));
    await settle();

    const fix = byText(document.getElementById("gen-findings"), "button", "Add dependent");
    assert.ok(fix, "the dependent-action finding offers a fix");
    click(fix);
    await settle();

    const policy = JSON.parse(document.getElementById("gen-output").textContent);
    assert.equal(policy.Statement.length, 2, "the cross-service dependency got its own statement");
    assert.deepEqual(
        policy.Statement.map((s) => [s.Action].flat()).flat().sort(),
        ["access-analyzer:StartPolicyGeneration", "iam:PassRole"],
    );

    // The dependency is satisfied now, so the offer has to go. It used to
    // survive -- the check only looked inside the statement it was reported
    // against, never at the statement the fix had just made to satisfy it.
    assert.equal(
        byText(document.getElementById("gen-findings"), "button", "Add dependent"),
        undefined,
        "the fix withdraws its offer once applied",
    );
    page.cleanup();
});

test("generate: the dependent-action fix cannot be applied twice", async () => {
    // Belt and braces for the button clearing above: clicking a stale handler
    // before the re-render must not push a second statement carrying the same
    // Sid, which would make the document invalid rather than merely redundant.
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "access-analyzer");
    const box = [...document.querySelectorAll(".action-picker .form-check-input")].find(
        (input) => input.id.includes("StartPolicyGeneration"),
    );
    change(Object.assign(box, { checked: true }));
    await settle();

    const fix = byText(document.getElementById("gen-findings"), "button", "Add dependent");
    click(fix);
    click(fix);
    click(fix);
    await settle();

    const policy = JSON.parse(document.getElementById("gen-output").textContent);
    assert.equal(policy.Statement.length, 2, "no statement was duplicated");

    const sids = policy.Statement.map((s) => s.Sid).filter(Boolean);
    assert.equal(new Set(sids).size, sids.length, `duplicate Sid in ${sids.join(", ")}`);
    page.cleanup();
});

test("generate: checking an action leaves the picker scroll position alone", async () => {
    // The picker is deliberately not re-rendered on toggle; only the resource
    // and condition sections below it are.
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "ec2");

    const picker = document.querySelector(".action-picker");
    const before = picker.firstElementChild;

    const box = picker.querySelector(".form-check-input");
    change(Object.assign(box, { checked: true }));
    await settle();

    assert.equal(
        document.querySelector(".action-picker").firstElementChild,
        before,
        "the picker's DOM nodes survive a selection",
    );
    page.cleanup();
});

// --- combobox widget -----------------------------------------------------------

test("combobox: arrow keys move the active option and Enter commits it", async () => {
    const { page } = await boot("browse");
    const { document, window } = page;

    const input = document.querySelector("#browse-service input");
    type(input, "s3");
    await settle();

    const press = (key) =>
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));

    press("ArrowDown");
    await settle();
    const active = document.querySelector("#browse-service .combobox-option.active");
    assert.ok(active, "an option is active after ArrowDown");

    press("Enter");
    await settle();

    assert.ok(input.value.length > 0, "Enter commits a selection");
    assert.ok(!document.getElementById("browse-body").classList.contains("d-none"));
    page.cleanup();
});

test("combobox: a non-matching query offers nothing", async () => {
    const { page } = await boot("browse");
    const { document } = page;

    type(document.querySelector("#browse-service input"), "zzzqqqnotaservice");
    await settle();

    assert.equal(document.querySelectorAll("#browse-service .combobox-option").length, 0);
    assert.ok(document.querySelector("#browse-service .combobox-empty"));
    page.cleanup();
});

test("combobox: blurring mid-query restores the committed label", async () => {
    const { page } = await boot("browse");
    const { document, window } = page;

    const input = document.querySelector("#browse-service input");
    await (async () => {
        type(input, "s3");
        await settle();
        mousedown(document.querySelector("#browse-service .combobox-option"));
        await settle();
    })();

    const committed = input.value;
    assert.ok(committed.includes("Amazon S3"));

    // Type a half-finished query, then leave without choosing anything.
    type(input, "lamb");
    await settle();
    input.dispatchEvent(new window.FocusEvent("blur", { bubbles: false }));
    await settle();

    assert.equal(input.value, committed, "an abandoned query is not a selection");
    page.cleanup();
});

test("combobox: clicking a committed box reopens the full list, label selected", async () => {
    const { page } = await boot("browse");
    const { document } = page;

    const input = document.querySelector("#browse-service input");
    const options = () => document.querySelectorAll("#browse-service .combobox-option").length;

    type(input, "s3");
    await settle();
    const matched = options();
    mousedown(document.querySelector("#browse-service .combobox-option"));
    await settle();

    // Committing keeps focus, so reopening arrives as a click, not a focus.
    click(input);
    await settle();

    assert.ok(options() > matched, "the whole list is offered again, not just the s3 matches");
    // Without the selection, the next keystroke appends to "Amazon S3 (s3)"
    // and the filter matches nothing.
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, input.value.length);
    page.cleanup();
});

// --- resource-scope splitting --------------------------------------------------

test("generate: wildcard-only actions are split out of a scoped statement", async () => {
    // eks:CreateCluster has no resource type, so pairing it with cluster ARNs
    // produces a grant that never applies. The generator splits instead.
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    await pickService(document, "#gen-statements .combobox", "eks");

    for (const name of ["CreateCluster", "CreateAddon", "CreateNodegroup"]) {
        const box = [...document.querySelectorAll(".action-picker .form-check-input")].find(
            (input) => input.id.endsWith(`-${name}-0`) || input.id.includes(`-${name}-`),
        );
        assert.ok(box, `${name} is in the picker`);
        change(Object.assign(box, { checked: true }));
        await settle();
    }

    const specific = byText(document, "label", "Specific ARNs");
    change(Object.assign(document.getElementById(specific.getAttribute("for")), { checked: true }));
    await settle();

    const policy = JSON.parse(document.getElementById("gen-output").textContent);
    assert.equal(policy.Statement.length, 2, JSON.stringify(policy, null, 2));

    const unscoped = policy.Statement.find((s) => s.Resource === "*");
    const scoped = policy.Statement.find((s) => s.Resource !== "*");

    assert.ok(unscoped, "a Resource:* statement was emitted");
    assert.deepEqual([unscoped.Action].flat(), ["eks:CreateCluster"]);
    assert.ok(
        ![scoped.Action].flat().includes("eks:CreateCluster"),
        "CreateCluster is not left among the scoped actions",
    );
    assert.match(
        document.getElementById("gen-findings").textContent,
        /separate statement/,
        "the split is explained in the checks panel",
    );
    page.cleanup();
});
