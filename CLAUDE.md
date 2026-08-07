# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
make data         # fetch both upstreams, rebuild site/data/  (~10s)
make data-cached  # rebuild from build/.cache/ without refetching — use while iterating
make serve        # http://localhost:8080
make test         # Python + JS suites
make test-visual  # Playwright/Chromium; downloads a browser, so it is not in `make test`
make lint         # ruff format, ruff check --fix, then pyright
make check        # clean + lint + test
```

Running a single test:

```sh
uv run --group dev pytest tests/test_build.py::test_merge_is_a_union_not_an_intersection
node --test tests/policy.test.mjs
node --test --test-name-pattern "wildcard" tests/policy.test.mjs
npx playwright test tests/visual/layout.spec.mjs --project=desktop
```

Python is run through `uv` with the `dev` dependency group; JS test deps come from `npm ci`
(`make test-js` installs them via the `node_modules` target). The site itself ships no npm
dependencies — `package.json` exists only for jsdom, Playwright, and a local Bootstrap copy.

`site/` must be served over HTTP. Opening `index.html` from the filesystem fails: the page
fetches `./data/*.json`, which `file://` blocks as cross-origin.

## Architecture

Two halves that meet at `site/data/`:

**`build/`** (Python) fetches three upstreams, merges them, and shards the result. It runs at
build time only — nothing in it is deployed. `build/models.py` holds pydantic models whose job
is to make the build fail loudly when AWS changes an upstream schema.

**`site/`** (vanilla ES modules, no bundler, no framework) is the entire deployable. Modules
split along a strict line:

- **DOM-free, directly unit-tested**: `policy.js` (every IAM semantic — document construction,
  statement splitting, validation), `arn.js` (ARN template parsing/rendering), and the scoring
  half of `combobox.js`. Put IAM logic here, not in the render layer.
- **Render layer**: `browse.js`, `generate.js`, `dom.js`, `app.js`. `dom.js` builds everything
  with `createElement`/`textContent` and never `innerHTML` — action descriptions and ARN
  templates come from upstream JSON and land in the page verbatim.

`data.js` is the only fetch path: `index.json` loads once, a service shard is fetched on
selection and memoized for the session. The navbar's CI badge is the page's one other external
request — a plain `<img>` from `github.com`, no JS involved.

`app.js` owns the account context (partition/region/account) and persists it to `localStorage`,
but the context is **Generate's alone**: `initBrowse()` takes no context and the change handler
only calls `refreshGenerate()`. The Browse tab shows action names, not ARNs. The controls live in
a band at the top of `#pane-generate` for that reason — they were in the navbar, where the
placement implied a page-wide scope the code never had.

### Data model invariants

These are upstream quirks the build normalizes; getting them wrong silently corrupts results:

- The two sources are **unioned by service prefix, not intersected**. Each has services the
  other lacks; intersecting drops dozens.
- `access_level` arrives as one comma-joined string (`"Permissions management, Write"`). The
  build splits it into the `access_levels` **list**. Treating it as a scalar drops most
  permission-management actions.
- A trailing `*` on a resource type name means **required**, stripped into a `required` boolean.
  An action with no resource type at all can only ever match `Resource: "*"` — `policy.js`
  splits such actions into their own statement rather than emitting a grant that never applies.
- `doc_page` is **not derivable from the prefix** (62 services disagree); it comes from the
  Service Authorization Reference's own `toc-contents.json`.

`site/data/` is generated but **committed** — the weekly diff is a readable log of AWS changes,
and the deploy ships what is on `main` without rebuilding, so live always matches the repo.
`global.json` deliberately carries no timestamp so it only changes when AWS does; per-run
metadata goes in `manifest.json`.

## Testing layers

| Layer | Runs | Covers |
|---|---|---|
| `tests/test_build.py` | pytest | merge logic, TOC parsing |
| `tests/policy.test.mjs`, `combobox.test.mjs` | `node --test` | pure logic, against the **real** generated shards |
| `tests/ui.test.mjs` | `node --test` + jsdom | render layer, driving the **real** `site/index.html` |
| `tests/visual/*.spec.mjs` | Playwright/Chromium | anything geometric |

`tests/harness.mjs` mounts the actual `site/index.html` in jsdom and wires `fetch` to the real
`site/data/`, so **renaming an element id the modules depend on fails the suite** — that is
intentional. It stubs only what jsdom lacks (`scrollIntoView`, `navigator.clipboard`,
`URL.createObjectURL`).

The JS suites reading real shards means shard-shape drift fails in CI rather than in a browser.

The visual suite asserts on **measurements, not pixel baselines** (baselines drift with platform
font rendering — a macOS shot fails on a Linux runner for unrelated reasons). Screenshots are
captured and uploaded as CI artifacts but are never a pass/fail gate. Two couplings to preserve:

- `tests/visual/fixtures.mjs` routes `cdn.jsdelivr.net` to `node_modules/`, so the gate is
  offline-clean. The Bootstrap version in `package.json` must match the pin in `site/index.html`
  or the `integrity` hash stops verifying — the fixture version-checks and says so explicitly.
- The same fixture stubs the navbar's `github.com` CI badge. GitHub sizes that badge to the word
  inside it, so an unstubbed run would make the navbar's width depend on whether `main` is green.
- `playwright.config.mjs` and `tests/visual/server.mjs` both read `PORT` (default 8081) and must
  agree. `server.mjs` exists because `python3 -m http.server`'s listen backlog of 5 cannot take
  eight parallel workers.

Specs live under `tests/visual/` specifically so `node --test tests/*.test.mjs` does not pick
them up.

## Data refresh and CI

`.github/workflows/data.yml` rebuilds weekly and **opens a PR** — `main` is protected, so the
bot cannot push directly. `ci.yml` is separate and read-only (test, lint, visual as three jobs)
so PR gating needs no write permissions and does not serialize on the `pages` concurrency group.
