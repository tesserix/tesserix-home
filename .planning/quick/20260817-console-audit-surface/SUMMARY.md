---
id: 260817-audit
slug: console-audit-surface
date: 2026-08-17
issue: 139
status: complete
---

# One audit-log surface in the console

The console serves `/platform/audit-log`: every product's audit trail plus the
console's own operator log, merged newest-first, with the source on every row.
`apps/web`'s three product-scoped audit pages are gone and redirect there.

| | |
|---|---|
| `02032fe` | `feat(web)`: make the product audit-logs route genuinely product-generic |
| `fe8ce5b` | `feat(console)`: one audit-log surface merging every product's trail and the console's own |
| `3fe378c` | `fix(web)`: attribute every audit entry to its source and namespace ids at the merge |
| `f9f8059` | `fix(console)`: show the source on every row of the merged audit timeline |
| `12d10d4` | `refactor(web)`: retire the three product audit pages into the console's merged timeline |

## The prerequisite the issue did not name

#139 reads as "replace three implementations with one". The three were not three
copies of one thing — they were three different architectures, and **two of them
were not reachable over HTTP from the console at all**:

| Product | Before | Console-reachable? |
|---|---|---|
| Mark8ly | `/api/admin/apps/[product]/audit-logs` → direct SQL into mark8ly's DB | Yes, but via a #160 cross-DB grant |
| Kora | a **server component** calling `lib/api/kora-admin.ts` in-process | **No** — no `/api/admin` route existed for it |
| Fe3dr | `/api/admin/apps/homechef/gw/[...path]` HMAC gateway | Yes |

So most of the work was not the console surface. It was making one endpoint that
could be read from outside the process that holds the HMAC keys.

The one route that *looked* product-generic was not — it read mark8ly's
`audit_logs` unconditionally, so serving it for another product returned
**mark8ly's rows under that product's URL**, and every product overview showed
mark8ly's critical-event count. Task 1 made it genuinely generic: a dispatch
table keyed by product, each source normalising onto one wire shape, an unknown
product answered `404` rather than an empty list, an unwired upstream answered
`501` (the console's `NOT_IMPLEMENTED` contract, not `503` — see #198), and
`Promise.allSettled` so one product being down yields partial results plus a
named `failures: {source, message}[]` rather than a blank page.

## The source-attribution defect

The first cut of the merge lost the one fact a merged timeline most needs. Three
products' rows went into one `entries[]` with nothing recording which product
produced each — so the console could not show a Source column, and worse, `id`
was no longer unique: `console_audit_log.id` is a plain sequence, and an integer
id from any product could collide with it in a list the renderer keys by `id`. A
collision there is a mis-reconciled audit row.

Fixed at the two places the fact is known: every normaliser attributes its own
rows via `attributeTo`, naming its source as a literal and namespacing the id as
`${source}:${id}`. Set **by the thing that produced the row**, not applied
afterwards by whoever happens to be merging — a route-level
`attributeTo(targets[i], …)` would read the same today and is one refactor away
from labelling a row with the wrong product.

Rendering it needed a decision. `@tesserix/web`'s `AuditLogViewer` has no source
field, no column slot and no render prop, so attribution could only reach a row
by being smuggled into `target` or `metadata` — both of which carry real audit
data, making the record say something the source did not record, a strictly
worse defect than the one being fixed. Grouping by source destroys the
interleaving that *is* the surface. So the list is rendered locally in
`sourced-audit-list.tsx`, mirroring the viewer's markup so the diff is a deletion
if a `source` slot ever lands upstream. **The design-system gap is real and worth
raising there.**

## Deliberate gaps

**No actor filter, and this is the finding rather than a shortcut.** A source
filter is exact — it changes which sources are *queried*, upstream, so every row
shown is still every row that source has. An actor filter cannot be: kora-api's
`/v1/admin/events` accepts no actor parameter and neither does homechef's, so it
could only be honoured by mark8ly and `console_audit_log`. The result would read
"3 events by alice" when Kora was never asked about alice. On any other surface
that is a nuisance; in an audit log it is a false negative, and a false negative
in an audit log is evidence of absence that is not evidence of anything. The
surface says so on the page. It comes back when those two upstreams take an
actor parameter — a change there first.

**`metadata` is rendered raw.** Each source stringifies its extras to JSON and
the row prints that string. Honest and unreadable. Making it readable means
deciding per source what is worth promoting to a column.

**Two different truncations, stated rather than implied.** The products'
aggregate is asked for the last 30 days capped at 200 rows; `console_audit_log`
is read as "the most recent 200" with no window, so a busy source reaches back
less far than a quiet one. The page says so — otherwise an operator reads the
oldest row on screen as the oldest row that exists.

**mark8ly still reads its DB directly.** #160's job; the debt is now commented at
the place that depends on it, not only in the tracker.

## What the retirement found

**The #199 redirect test harness answered the opposite of production.** It called
`prepareDestination({appendParamsToQuery: true})` and formatted the result — that
is Next's *rewrite* path. The redirect branch passes `false` and rebuilds
`search` from the merged query, because `prepareDestination` merges into
`parsedDestination.query` while leaving `.search` holding only the destination's
own query string, and `formatUrl` prefers `.search`. The two agreed as long as no
destination had a query string — #199's did not. These do (`?source=mark8ly`),
and the old helper reported the request's params as **dropped** when Next in fact
carries them. Fixed to mirror the redirect branch; all seven #199 assertions pass
unchanged, confirming the paths agreed until now.

Each redirect carries `?source=`, so a bookmark to Kora's audit trail lands
filtered to Kora rather than silently widening to the whole estate.

**Two things that looked orphaned and were not.** `event-table.tsx` is also
imported by `app/admin/apps/kora/foods/[id]/page.tsx`, which is not being
retired; kept in place rather than moved under `components/`, because
`vitest.config.ts`'s include is `lib/**` and `app/**` only and its tests would
have been silently uncollected. And `summary.criticalLast24h` survives the rest
of the legacy body: `product-overview-layout.tsx` renders it on every product
overview, and a 24-hour aggregate is not derivable from a capped merged list.

**`ESTATE` records Kora's rail entry count** and its own test checks it against
`koraNav.length` — dropping the Audit trail entry took it 5 → 4. Caught by a
guard nobody remembered, which is what it is for.

`BASELINE.adminPages` 69 → 66 in the same commit as the deletions.
`adminApiRoutes` stays at 51, and the ratchet now asserts the audit route still
*exists* — deleting it as "more of the same cleanup" would take the replacement
surface down with the surfaces it replaced.

## This substantially delivers #158

#158 is "one audit timeline across products" in M6. Under its reframe as an
aggregating reader it is nearly this exact surface, over the same normalised
data — and what shipped here is the estate-wide one. **#158 should be re-read
against what exists rather than planned from its original text.** What is
genuinely left of it: an actor filter (blocked on the two upstreams above),
readable `metadata`, and time-range selection.

## Verification

`pnpm test` 8/8, `pnpm lint` 6/6, `pnpm typecheck` 9/9, `pnpm build` 5/5.

The ratchet was mutation-tested both ways: restoring `kora/audit/page.tsx` fails
it twice, and leaving the baseline at the pre-#133 `72` trips the `SLACK = 5`
drift guard.
