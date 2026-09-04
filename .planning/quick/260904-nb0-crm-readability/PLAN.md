---
id: 260904-nb0
slug: crm-readability
date: 2026-09-04
issue: "#249 (parts 2 and 3) and #252 §A"
kind: quick
---

# CRM readability: data collected and never shown

Three findings share one theme — a value is written faithfully, filtered on,
and rendered nowhere — so they are planned together. Research corrected the
issues on four points before a line was written; each is recorded below the
task it changes, because each one changes what "done" means.

## What the issues got wrong, and why it matters

**#249's "unreachable from every surface" is false.** Won deals have a
dedicated Handoff tab (`crm/page.tsx:533-535`; `wonWithoutConversion` is
`WHERE o.stage = 'won'`, `crm-repo.ts:2394`), and the organisation detail page
lists *every* opportunity with no stage predicate at all
(`crm-repo.ts:1317-1321`), badges and `lost_reason` included. A terminal deal
is two clicks away **if you already know the organisation**. The true gap is
narrower: there is no aggregate, filterable list of terminal deals, `lost` has
no surface of its own, and a won deal that has been *converted* is on no list
anywhere (Ruling 35, `crm-repo.ts:2316-2340`).

**#249's "cheap: the filter machinery already exists" is now false.** Since
2026-08 the queues have had a second implementation: `lib/crm-queues.ts:20-30`
routes to Postgres or the Go platform-api, and the Go side refuses terminal
stages with a 422 **by design** — `handler.go:43-54`, an enumerated wire error
with a golden file. Admitting won/lost to the existing `stage` axis is a
two-language change against a contract that `crm-queues.ts:76-83` explicitly
warns not to break unilaterally. **T4 therefore adds a tab, not a filter
value** — a new read, not a new value on an existing axis, so the Go contract
stands untouched.

**#249's "reuse ResultPager" is the wrong precedent.** #246 — the third
truncating queue, named in #249's own Related line — was fixed *after* #240 and
went the other way: a `limit + 1` probe row and a sentence, no pager
(`crm-repo.ts:2358-2373`, `handoff-view.tsx:357-367`). Its doc comment gives
the reason: a `COUNT` "would need a second scan of the same join on a shared
instance, and the only decision it informs … is the same at 101 as at 1,001."
That applies to a single organisation's timeline with more force, not less.
**T3 follows #246.**

**#252 §A's "add a column to both surfaces" is not coherent.** The work
surface has no table — `queue-view.tsx:107` renders `QueueList`, and
`queue-list.tsx:127-130` states "Not a table: queue rows are read as units".
`QUEUE_COLUMNS` does not select `g.location`, let alone `g.country`. **The
queues are out of scope for T1 and T2.** And "filter to India and see no row's
country" overstates it: `Location` *is* rendered (`organisations-view.tsx:196`),
so the operator sees "Chennai". The real gap is that the **derived** value is
invisible, so nobody can tell which rows the mapper resolved — and 208 of 259
resolved to nothing (`crm-filters.ts:79-83`).

## Tasks

Ordered so the two that share files do not run concurrently. T3 and T4 are
independent of T1/T2 and of each other.

### T1 — show the primary contact's follower count on the browse list

The higher-value half of #252 §A: the only quantitative qualification signal in
the CRM, invisible on every surface including the detail page.

- `crm-repo.ts` — a fourth primary-contact subquery beside the existing three
  (`:2912-2929`), using the same `primaryContactOrder` + `notErased` pair.
  `followersCount: number | null` onto `RawOrganisationListRow` (`:2769`),
  `toOrganisationListRow` (`:2783`), `OrganisationListRow` (`:2621`).
- `organisations-view.tsx` — a right-aligned `tabular-nums` "Followers" column
  after "Open". Compact (`12.4k`), full count in `title`, muted `—` when null.
- **Agreement with the filter is the invariant, and it is free by
  construction**: `primaryContactFollowerClause` (`:170-197`) resolves the
  primary contact with the identical ordering, and its own doc says it is
  written that way "so a filter can never resolve a different contact than the
  one on screen". `notErased`'s doc (`:1230-1237`) names the display columns
  and the follower clauses as one set that must agree. The new subquery joins
  that set.
- **Never render an absent count as `0`** — `UNKNOWN_LABEL`'s doc forbids it
  (`crm-filters.ts:88-95`): the rows behind it have no recorded value, which is
  not the claim a measured zero makes.
- Formatter: there is no shared one. `formatFollowers` in
  `apps/web/app/admin/apps/mark8ly/leads/page.tsx:964-968` is exactly the wanted
  behaviour but lives in another app over a different table — **do not import
  across the app boundary.** Re-author the four lines in the console with a
  comment naming the prior art. (`lib/ai-usage.ts:319` `tokenFormatter` is
  domain-named for tokens and capitalises the K; not it.)

Done when: a row returned under `followers: "over10k"` displays a number
`>= 10000`; an org whose only contact is erased shows `—` **and** falls in the
Unknown band; `organisations-view.test.tsx` gains a followers-cell describe
mirroring the products one; an integration assertion makes the
filter/display-agreement claim load-bearing rather than incidental.

**Watch:** `renderRowWithProducts` (`organisations-view.test.tsx:89-119`)
builds a full `OrganisationListRow` literal — adding a field breaks it. That is
the intended blast radius, not a surprise.

### T2 — make the derived country auditable

Not a sixth column. Location already holds that slot and carries strictly more
information, and `ProductsCell`'s own doc (`organisations-view.tsx:30-38`)
argues the five-column table is already at its width budget.

- `crm-repo.ts` — add `g.country` to `listOrganisations`' SELECT (`:2911`) and
  to `organisationDetail`'s org SELECT (`:1269-1272`).
- `organisations-view.tsx:196` — render the country as a muted second line
  inside the existing Location cell: `Chennai` over muted `India`. A null
  country under a non-null location renders muted `Unknown`, matching
  `UNKNOWN_LABEL`.
- `[organisation]/page.tsx:169` — one `Country` entry in the detail summary
  rail after Location, `"Not derived"` when null (the rail's convention is the
  string `"Not recorded"`, `:167-172`; `"Not derived"` is the honest wording
  here because the column is computed, not collected).
- Mapper: `COUNTRY_LABELS[code] ?? code` — canonical in
  `packages/crm-country/index.mjs:44-47`, re-exported at `lib/db/crm-country.ts`.
  **The only one.** No `Intl.DisplayNames` anywhere in the repo; do not add one.

Done when: an operator can see which rows the mapper resolved and which fell
to Unknown, on both the list and the detail page.

**Separate commit from T1.** Different table, different SQL shape (a scalar
column vs a correlated subquery), different display idiom, and different risk —
T1 carries an invariant that deserves its own test-bearing commit and its own
review.

### T3 — stop the activity timeline truncating silently

Follow #246, not #240 (see above).

- `crm-repo.ts` — fetch `ACTIVITY_LIMIT + 1` (`:1177`, used `:1336`), slice
  back to `ACTIVITY_LIMIT`, surface `hasMore` on `OrganisationDetail` (`:1168`).
- **Add `, id DESC` to the ORDER BY (`:1334`) in the same change.** It is the
  only paged read in the file with no tiebreaker — `queuePage` `:434`,
  `listOrganisations` `:2939` and `primaryContactOrder`'s header `:1210` all
  explain why `id` last is load-bearing when a batch write shares a timestamp
  exactly, and `linkConversion`/`commitImport` do write several rows sharing
  `occurred_at`. Harmless under a plain `LIMIT`; it costs nothing to remove the
  latent tie now.
- `[organisation]/page.tsx` — pass the flag through.
- `organisation-detail-view.tsx` `ActivityTab` (`:601-650`) — one `Callout`
  below the list, worded after `handoff-view.tsx:361-366`.

Explicitly **not** doing: a cursor, a `searchParams` on this route, or a
`COUNT`. `DetailLayout` holds the active tab in `useState` on purpose
(`surface-tabs.tsx:41-45`), so a `?cursor=` link is a full server navigation
that resets the tab and discards in-progress `TemplateComposer` /
`ActivityComposer` state. That regression is not worth backward paging through
a history that is under 20 rows in practice.

Done when: an operator at the bottom of a capped timeline is told it is not the
bottom. Tests mirror `crm-repo.test.ts:1668` / `:1692` (probe row bound; no
overflow at exactly the cap) — note **no test asserts `ACTIVITY_LIMIT` today**,
so this adds the first. `ActivityTab` has no render test either; add one.

### T4 — a Closed tab, giving terminal deals a list

The largest task, and the one whose issue text was most wrong. Scope it to a
read, not a filter change.

- `crm/page.tsx:400` — `CrmTab = "work" | "handoff" | "closed"`. The tab enum,
  the `tabHref` builder that preserves every other param (`:513-531`), the tab
  strip (`:533-565`) and the per-tab renderer that reads **only** the active
  tab's data (`:702-`, pinned by `page.test.tsx:801, 813`) all already exist.
  Adding a third tab is additive.
- `crm-repo.ts` — one new `closedOpportunities(filter, limit, cursor)` reusing
  `queuePage` (`:373`) with `buildWhere: params => \`o.stage IN ('won','lost')${filterClause(filter, params)}\``
  and `sortKey: "o.closed_at"`.
- On this tab the stage select offers `won`/`lost` instead of
  `OPEN_CRM_STAGES` (`crm/page.tsx:156-160`).

Why this and not the filter route:
- **Zero existing predicates change**, so `crm-repo.test.ts:303` and the
  ordering test at `:509-511` — which pins that the terminal-stage predicate
  comes first — keep passing untouched.
- **No Go change.** A new read, not a new value on the existing `stage` axis,
  so `handler.go`'s 422 and its golden file stand.
- Both partial indexes (`0019_crm_schema.sql:132-137`) are left alone and stay
  correct: the new query wants the complement of their predicate, so it was
  never going to use them. At 259 rows a seq scan is sub-millisecond
  (`crm-repo.ts:505-510` already says so about the drifting sort).
- The queues sort by *urgency* — `next_action_at`, `quiet_since`. A won deal
  has no next action and its quietness is meaningless. Admitting terminal
  stages orders rows by a key that does not apply to them, under a heading that
  reads "Due". `crm-repo.ts:467-470` says it plainly: "surfacing them would
  make the queue a to-do list of things already finished."

**One loose end to fix here because it is the real bug in the reader:** narrow
`readQueueFilters`' stage check (`crm/page.tsx:253`) per-tab, using the existing
`isOpenStage` (`lib/crm.ts:52-55`), so `?stage=won` on the Work tab reads as
*unfiltered* rather than silently producing a contradiction
(`stage NOT IN ('won','lost') AND o.stage = 'won'` → zero rows, no error). That
honours the contract `page.tsx:232-238` claims for itself and that
`crm-queues.ts:78-83` records as violated. `page.test.tsx:506` asserts the Work
tab offers no won/lost — that stays true and stays passing.

## Verification

Per task, before its commit — CI runs exactly these
(`.github/workflows/ci.yml:147-156`):

    pnpm --filter console lint
    pnpm --filter console typecheck
    pnpm --filter console test:unit

Integration tests run on pglite (`@electric-sql/pglite`), no external database.

Whole-branch, before the PR: all of the above green, plus `next build`. A
typecheck is not a build — server-only code reaching the browser passes `tsc`
and fails the build.

## Sequencing

T1 → T2 (shared files: `crm-repo.ts` `listOrganisations`,
`organisations-view.tsx`). T3 and T4 are independent of those and of each
other. One atomic commit per task; this plan commits first.
