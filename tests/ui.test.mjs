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

let nonce = 0;

/**
 * Boot the whole app the way the browser does, through app.js.
 *
 * The per-tab `boot` below calls initBrowse/initGenerate directly, which skips
 * everything app.js owns — the context bar wiring and the status chip among it.
 * app.js runs `main()` on import, so there is nothing to call: import it and let
 * the awaited fetches settle.
 */
async function bootApp() {
    const page = setupPage();
    await import(`../site/js/app.js?t=${nonce++}`);
    await settle();
    await settle();
    return page;
}

/**
 * Boot a tab. Modules hold module-level state, so each test imports them fresh
 * with a cache-busting query — otherwise tab two inherits tab one's DOM refs.
 */
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
    const remove = document.querySelector(".statement-card .stmt-remove");
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

test("generate: two statements given the same Sid raise an error", async () => {
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    click(document.getElementById("gen-add-statement"));
    await settle();

    const sids = document.querySelectorAll('#gen-statements input[placeholder="Sid (optional)"]');
    assert.equal(sids.length, 2, "both statements offer a Sid field");
    type(sids[0], "ReadOnly");
    type(sids[1], "ReadOnly");
    await settle();

    const error = byText(document.getElementById("gen-findings"), ".finding-error", "Sid");
    assert.ok(error, "the duplicate is reported");
    assert.match(error.textContent, /Statement 2: .*already used by statement 1/);

    // Renaming one clears it -- the finding tracks the field, not a first sighting.
    type(sids[1], "WriteOnly");
    await settle();
    assert.equal(
        byText(document.getElementById("gen-findings"), ".finding-error", "Sid"),
        undefined,
        "the error clears once the Sids differ",
    );
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

// --- App shell: context placement and the status chip -------------------------

test("app: the account context belongs to Generate, not the navbar", async () => {
    // The reason for the move. The controls sat in the navbar, which read as a
    // page-wide scope, but nothing on Browse has ever consumed them: initBrowse
    // takes no context and the change handler only refreshes Generate.
    const page = await bootApp();
    const { document } = page;

    for (const id of ["ctx-partition", "ctx-region", "ctx-account", "ctx-arn"]) {
        const node = document.getElementById(id);
        assert.ok(node, `#${id} exists`);
        assert.ok(node.closest("#pane-generate"), `#${id} sits inside the Generate pane`);
    }

    // Hooked on the ids rather than on `.form-select`: the navbar does hold one
    // select now, the theme picker, and that one belongs there — the theme is
    // page-wide in a way the account context never was.
    assert.equal(
        document.querySelector("nav #ctx-partition, nav #ctx-region, nav #ctx-account"),
        null,
        "no context inputs are left in the navbar",
    );
    page.cleanup();
});

test("app: the context band echoes the ARN the fields build", async () => {
    const page = await bootApp();
    const { document } = page;
    const echo = () => document.getElementById("ctx-arn").textContent;

    // Rendered before the first keystroke. An unset account wildcards to `*`,
    // the same rule renderArn applies to the previews inside a statement — the
    // echo would misrepresent the output if it invented its own convention.
    assert.match(echo(), /^arn:aws:/, `echoed on load: ${echo()}`);
    assert.match(echo(), /:\*:⟨resource⟩$/, `an unset account wildcards: ${echo()}`);

    type(document.getElementById("ctx-account"), "111122223333");
    await settle();
    assert.match(echo(), /:111122223333:/, `the echo follows the field: ${echo()}`);

    type(document.getElementById("ctx-region"), "eu-west-2");
    await settle();
    assert.match(echo(), /:eu-west-2:/, `region too: ${echo()}`);
    page.cleanup();
});

test("app: the CI badge reserves its space and points at the workflow", async () => {
    // The badge is a remote image, so it is absent until github.com answers.
    // Without intrinsic dimensions it would lay out at zero width and shove the
    // navbar sideways when it lands; these attributes are what prevent that.
    const page = await bootApp();
    const badge = page.document.getElementById("ci-badge");

    assert.ok(badge, "the badge is in the markup");
    assert.equal(badge.getAttribute("width"), "90");
    assert.equal(badge.getAttribute("height"), "20");
    assert.match(badge.getAttribute("src"), /\/actions\/workflows\/ci\.yml\/badge\.svg/);
    assert.ok(badge.getAttribute("alt"), "the badge carries alt text");

    const link = page.document.getElementById("ci-status");
    assert.match(link.getAttribute("href"), /\/actions\/workflows\/ci\.yml$/);
    assert.equal(link.getAttribute("rel"), "noopener");

    // The repo link's mark is decorative, so the accessible name has to come
    // from the text beside it.
    const repo = page.document.getElementById("repo-link");
    assert.match(repo.getAttribute("href"), /github\.com\/[^/]+\/[^/]+$/);
    assert.match(repo.textContent.trim(), /View on GitHub/);
    assert.equal(repo.querySelector("svg").getAttribute("aria-hidden"), "true");
    page.cleanup();
});

test("generate: switching a statement to Deny marks the panel", async () => {
    // A Deny inverts the meaning of everything under it. The effect select
    // scrolls out of view on a long statement, so the marker on the panel is
    // what keeps that readable — and it is set from the change event, since the
    // panel does not exist yet while its own header is being built.
    const context = { partition: "aws", region: "us-east-1", account: "" };
    const { page } = await boot("generate", context);
    const { document } = page;

    const card = document.querySelector(".statement-card");
    assert.equal(card.classList.contains("is-deny"), false, "starts as an Allow");

    const effect = card.querySelector("select");
    change(Object.assign(effect, { value: "Deny" }));
    await settle();

    assert.ok(card.classList.contains("is-deny"), "the panel is marked");
    assert.equal(
        JSON.parse(document.getElementById("gen-output").textContent).Statement[0].Effect,
        "Deny",
        "and the document agrees",
    );

    change(Object.assign(effect, { value: "Allow" }));
    await settle();
    assert.equal(card.classList.contains("is-deny"), false, "and it clears again");
    page.cleanup();
});

// --- Theme picker ------------------------------------------------------------

/**
 * A page with the theme module freshly imported, optionally with a preference
 * already in storage — which has to be seeded before `initTheme` reads it, so
 * `bootApp` is no use here.
 */
async function bootTheme(stored) {
    const page = setupPage();
    if (stored !== undefined) page.window.localStorage.setItem("apva.theme", stored);

    const theme = await import(`../site/js/theme.js?t=${nonce++}`);
    theme.initTheme();
    return { page, theme };
}

test("theme: both controls are offered, defaulting to Slate following the OS", async () => {
    // Through app.js, so this also covers the wiring: initTheme has to be called
    // on the shell's own path, not only when a test reaches for the module.
    const page = await bootApp();
    const [family, mode] = ["theme-family", "theme-mode"].map((id) =>
        page.document.getElementById(id),
    );

    assert.ok(family && mode, "both selects are in the markup");

    const { FAMILIES, MODES } = await import("../site/js/theme.js");
    assert.deepEqual(
        [...family.options].map((o) => o.value),
        FAMILIES.map((f) => f.id),
    );
    assert.deepEqual(
        [...mode.options].map((o) => o.value),
        MODES.map((m) => m.id),
        "System leads the modes — it is the default",
    );

    assert.equal(family.value, "slate", "the palette the page shipped with");
    assert.equal(mode.value, "system", "an untouched visitor follows the OS");
    page.cleanup();
});

test("theme: the two controls are independent", async () => {
    // The whole reason for splitting them. With one flat list of six, choosing
    // Parchment meant giving up following the OS, and vice versa.
    const { page } = await bootTheme();
    const root = page.document.documentElement;
    const family = page.document.getElementById("theme-family");
    const mode = page.document.getElementById("theme-mode");

    family.value = "parchment";
    change(family);

    // Still following the OS, now in Parchment. The harness reports "not light",
    // so it resolves dark.
    assert.equal(root.getAttribute("data-theme"), "parchment-dark");
    assert.equal(mode.value, "system", "picking a palette left the mode alone");
    assert.equal(page.window.localStorage.getItem("apva.theme"), "parchment-system");

    mode.value = "light";
    change(mode);

    assert.equal(root.getAttribute("data-theme"), "parchment-light");
    assert.equal(family.value, "parchment", "picking a mode left the palette alone");
    assert.equal(
        root.getAttribute("data-bs-theme"),
        "light",
        "Bootstrap's chrome is put in the same mode, or its form-select chevron " +
            "stays the wrong colour",
    );
    assert.equal(page.window.localStorage.getItem("apva.theme"), "parchment-light");
    page.cleanup();
});

test("theme: every id agrees with the mode its suffix advertises", async () => {
    // index.html's pre-paint script derives data-bs-theme from the suffix alone,
    // having no access to this table. An id that disagreed with its own mode
    // would paint one theme before the module loads and another after.
    const { THEMES } = await import("../site/js/theme.js");

    for (const { id, mode } of THEMES) {
        assert.ok(
            id.endsWith(`-${mode}`),
            `${id} must end in -${mode} for the pre-paint script to read it`,
        );
    }
});

test("theme: a family id cannot contain the separator", async () => {
    // A preference is split at its last hyphen, so a family called "warm-slate"
    // would parse as family "warm" and mode "slate" — both unknown, and every
    // stored preference naming it would silently reset to the default.
    const { FAMILIES } = await import("../site/js/theme.js");

    for (const { id } of FAMILIES) {
        assert.ok(!id.includes("-"), `family "${id}" must not contain a hyphen`);
    }
});

test("theme: a stored value naming nothing falls back rather than being stamped", async () => {
    // A hand-edited entry, or a family from a build where they were named
    // differently. Stamping it would leave data-theme matching no block.
    const { page } = await bootTheme("vaporwave-light");
    const root = page.document.documentElement;

    assert.equal(root.getAttribute("data-theme"), "slate-dark", "resolved, not echoed");
    assert.equal(page.document.getElementById("theme-family").value, "slate");
    assert.equal(page.document.getElementById("theme-mode").value, "system");
    page.cleanup();
});

test("theme: a bare \"system\" from the old picker still follows the OS", async () => {
    // What the single-select picker wrote for "follow the OS". It named no
    // family because there was only one it could mean. Read as a preference it
    // parses as nothing, so without the migration it would reset to the default
    // — which happens to look identical here, and would not on a light desktop.
    const { page } = await bootTheme("system");

    assert.equal(page.document.getElementById("theme-family").value, "slate");
    assert.equal(
        page.document.getElementById("theme-mode").value,
        "system",
        "carried across as following the OS, not as an unreadable value",
    );
    page.cleanup();
});

test("theme: a remembered choice survives the reload", async () => {
    // "carbon-dark" is also exactly what the old picker stored for a pinned
    // theme, so this doubles as the other half of the migration.
    const { page } = await bootTheme("carbon-dark");

    assert.equal(page.document.documentElement.getAttribute("data-theme"), "carbon-dark");
    assert.equal(page.document.getElementById("theme-family").value, "carbon");
    assert.equal(page.document.getElementById("theme-mode").value, "dark");
    page.cleanup();
});
