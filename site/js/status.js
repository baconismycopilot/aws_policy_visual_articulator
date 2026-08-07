"use strict";

/**
 * Build status for the navbar chip.
 *
 * The only fetch in the app that is not dataset access, and the only one that is
 * allowed to fail quietly: the chip is a maintainer's convenience, not something
 * the page needs in order to work. Every failure path -- offline, throttled,
 * renamed workflow, a shape we do not recognise -- leaves the chip in the
 * unknown state the markup already ships, so nothing here can break a page load.
 *
 * Unauthenticated api.github.com allows 60 requests an hour per IP. That is
 * ample for this site's traffic, and being throttled degrades to the same
 * unknown state as being offline.
 */

const RUNS_URL =
    "https://api.github.com/repos/baconismycopilot/aws_policy_visual_articulator/" +
    "actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=1";

/** GitHub reports several kinds of red; they all read as failing here. */
const FAILING = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * Fetch the latest completed run on main and label the chip with its outcome.
 *
 * @returns {Promise<void>} always resolves -- callers do not need to catch.
 */
export async function initStatus() {
    const chip = document.getElementById("ci-status");
    const label = document.getElementById("ci-status-text");
    if (!chip || !label) return;

    let conclusion = null;
    try {
        const response = await fetch(RUNS_URL, {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (response.ok) {
            const body = await response.json();
            conclusion = body?.workflow_runs?.[0]?.conclusion ?? null;
        }
    } catch {
        // Offline, blocked, or CORS-refused. The unknown state already covers it.
    }

    if (conclusion === "success") {
        chip.classList.add("status-ok");
        chip.title = "CI is passing on main";
        label.textContent = "CI · passing";
    } else if (FAILING.has(conclusion)) {
        chip.classList.add("status-fail");
        chip.title = "CI is failing on main";
        label.textContent = "CI · failing";
    }
}
