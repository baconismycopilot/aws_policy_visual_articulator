# AWS Policy Visual Articulator

Browse every AWS IAM action and build policies from them. A static site — no
server, no database, no build tooling beyond a Python script that refreshes the
data.

- **Browse** — find a service by name or IAM prefix, then read every action with
  its access levels, resource-scoping requirements, and a link straight to its
  entry in the Service Authorization Reference.
- **Generate** — build IAM identity policies, resource-based policies (S3, SQS,
  SNS, VPC endpoint), and role trust policies, with validation driven by the
  metadata AWS publishes.

## Quick start

```sh
make data     # fetch both upstreams, rebuild site/data/  (~10s)
make serve    # http://localhost:8080
```

`site/` is the whole deployable — copy it anywhere that serves static files.
Opening `index.html` directly from the filesystem will *not* work: the page
fetches its data over HTTP and `file://` blocks that as cross-origin.

## Where the data comes from

| Source | Supplies | Notes |
|---|---|---|
| [`awspolicygen.s3.amazonaws.com/js/policies.js`](https://awspolicygen.s3.amazonaws.com/js/policies.js) | ARN formats, condition operators, global condition keys, policy types | AWS's own policy-generator data. Still actively maintained. Sends **no CORS headers**, which is why a build step exists. |
| [`iann0036/iam-dataset`](https://github.com/iann0036/iam-dataset) | Per-action access levels, resource types, dependent actions, condition keys | A scrape of the Service Authorization Reference. |

Neither is complete on its own — the build takes their **union**, not their
intersection. At the last run both sources listed the same 453 service
prefixes, but they still disagreed on actions: policies.js carried 19
`sms-voice` actions the SAR had not published yet. Prefix coverage has diverged
before and will again, so the merge stays a union — `manifest.json` records
which services each source contributed alone.

Everything under `site/data/` is derived from those sources and carries their
terms, not this project's — see [NOTICE](NOTICE).

## What the generator checks

These come straight out of the dataset, and are the reason this is more useful
than hand-writing JSON:

- **Actions that can't be scoped are split out automatically.** Some actions
  have no resource type at all — `eks:CreateCluster`, for instance — so they
  only ever match `Resource: "*"`. Listing one alongside specific ARNs produces
  a grant that silently never applies: IAM accepts the policy, the permission
  just never takes effect. The generator emits those actions as their own
  `Resource: "*"` statement and leaves the rest scoped, because splitting is
  the only way to express both halves correctly.
- **Actions that should be scoped.** An action with a *required* resource type
  left at `Resource: "*"` is broader than it needs to be. Reported as a
  **warning**.
- **Dependent actions.** AWS documents 2,812 of these across 285 services
  (`access-analyzer:StartPolicyGeneration` needs `iam:PassRole`, and so on).
  Nothing in the IAM console surfaces them. One click adds them, in a new
  statement when they belong to another service.
- **Privilege escalation.** Any action carrying the *Permissions management*
  access level.
- **Public access.** `Principal: "*"` on a resource-based policy with no
  `Condition`.

## Layout

```
build/
  build.py            fetch, merge, shard
  models.py           pydantic models — the build fails loudly on schema drift
site/                 the deployable
  index.html
  js/
    data.js           shard loading and caching
    arn.js            ARN template parsing            (DOM-free)
    policy.js         document construction, checks   (DOM-free)
    combobox.js       fuzzy service picker            (scoring is DOM-free)
    browse.js         Browse tab
    generate.js       Generate tab
    dom.js            element helpers
  data/               generated — see "Refreshing"
tests/
  test_build.py       merge logic and TOC parsing
  policy.test.mjs     policy engine, against real shards
  combobox.test.mjs   fuzzy ranking, against the real service index
  ui.test.mjs         render layer, in jsdom
  harness.mjs         mounts site/index.html with the real data
  visual/             layout and colour, in Chromium
    layout.spec.mjs   overflow, stacking, contrast
    screenshots.spec.mjs  captures for human review, not a gate
    server.mjs        static server for the suite
```

`policy.js` and `arn.js` hold every IAM semantic and deliberately touch no DOM,
so `node --test` exercises them directly against the generated shards.

The render layer is covered separately: `ui.test.mjs` mounts the real
`site/index.html` in jsdom, wires `fetch` to the real `site/data/`, and drives
the page through synthetic events. Because it loads the actual markup, renaming
an element id the modules depend on fails the suite. No browser or webdriver is
involved, so the whole thing runs in well under a second.

jsdom does no layout, so anything geometric goes in `tests/visual/`, which runs
in Chromium at desktop and phone widths (`make test-visual`). It asserts on
measurements rather than pixel baselines — nothing overflows the viewport, the
dropdown opens inside it and paints above the table, access-level badges clear
WCAG AA. Baselines were avoided deliberately: they drift with the platform's
font rendering, so a shot taken on macOS fails on a Linux runner for reasons
unrelated to the change. Screenshots are still captured and uploaded as CI
artifacts, just never as a pass/fail gate.

## Refreshing

`.github/workflows/data.yml` rebuilds weekly (Mondays 06:00 UTC) and **opens a
PR** when the data changed — `main` is protected, so the bot cannot push to it
directly. Merging that PR redeploys the site.

The deploy job ships whatever is committed on `main` and deliberately does not
rebuild, so what is live always matches what is in the repo. Committing the
shards is deliberate too — the weekly diff is a readable log of what AWS added,
removed, or reclassified.

Locally:

```sh
make data          # refetch and rebuild
make data-cached   # rebuild from build/.cache/ without refetching
make test          # Python + JS suites (installs jsdom on first run)
make check         # clean, lint, test
```

The site itself has no npm dependencies. `package.json` exists solely for
jsdom.

## Data shape

```
site/data/global.json        condition operators, global condition keys, policy types
site/data/index.json         453 services: prefix, name, action count   (~6 KB gzipped)
site/data/svc/<prefix>.json  one shard per service                      (~1 KB median)
site/data/manifest.json      build metadata, per-source service coverage
```

The index loads once; a shard is fetched on selection and memoized. The largest
shard (`ec2`) is 32 KB gzipped; the median is 1.1 KB.

Two upstream quirks the build normalizes:

- **`access_level` is multi-valued.** The SAR encodes it as one comma-joined
  string — `"Permissions management, Write"` covers 377 actions and
  `"Tagging, Write"` another 681. The build splits it into `access_levels`;
  treating it as a scalar silently drops most permission-management actions.
- **A trailing `*` on a resource type means required** (`object*`). The build
  strips it into a `required` boolean.
- **Documentation pages are not derivable from the prefix.** 62 services
  disagree (`airflow` → `list_mwaa`, `aps` → `list_amp`), and the older
  name-derived scheme (`list_amazons3.html`) now redirects to the index. The
  build reads the reference's own `toc-contents.json` and stores the page stem
  per service, which covers 453/453.

## License

[MIT](LICENSE) for this project's own code.

The generated data under `site/data/` is not original to this project. It
derives from [iam-dataset](https://github.com/iann0036/iam-dataset) (MIT,
© 2021 Ian Mckay) and from data published by AWS, whose terms govern it.
[NOTICE](NOTICE) has the details.

Not affiliated with, endorsed by, or sponsored by Amazon Web Services.
Generated policies come with no warranty — read them before you apply them.
