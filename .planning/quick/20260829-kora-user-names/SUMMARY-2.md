---
slug: kora-user-names
part: 2
date: 2026-08-29
status: complete
---

# Users-table filters, and `by_kind` as a diagnosis

| | |
|---|---|
| `9e11936` | `feat(console)`: search and activity filters on the kora ai-metrics users table |
| `63a1414` | `feat(console)`: group ai-metrics outcome kinds by what an operator does about them |

## C. Filters, and the honesty problem they create

Kora's `ai-metrics` accepts only `from`, `to`, `page`, `limit` — no server-side
search, and unknown parameters are rejected. So filtering happens client-side over
the page already fetched, which creates the defect worth naming:

**A filtered list beside an unfiltered total is a lie.** Filter to 3 rows while the
pager still reads "1–50 of 500" and an operator concludes 3 users match. In fact 3
match *on this page*. Same shape as a short inbox queue reading as "nearly done".

Solved by not showing both. Unfiltered renders the real `ResultPager` with the true
cross-page `pagination.total`. Filtered **replaces** it with a page-scoped line —
"N of M on this page match these filters" — so the cross-page total never appears
next to a narrowed list. The limitation is stated in the UI, not only in a comment.

`resolveState`'s `filtered` flag drives a distinct filtered-empty state ("No
matches — clear filters") rather than the surface's "No users in this window",
which would read as "there is nothing here" when there is.

Filters — `q`, `hasCorrections`, `hasBudgetRefusals`, `hasAiCalls` — live in the
URL via the existing `useUrlFilters`, so a filtered view is linkable and survives a
reauth round-trip. Search matches the joined name and email from part 1 **and** the
raw id, so a UUID pasted from elsewhere still finds its row.

No "needs human" toggle: that is an aggregate on `outcomes`, not a per-user field.
Inventing one would have implied a per-user fact kora does not send.

## D. `by_kind` grouped, and only two kinds linked

It rendered ten equal numbers in declaration order. It is actually **why each
resolution attempt ended**, and the kinds drive different fixes.

| Group | Kinds |
|---|---|
| Needs attention | `no_match`, `below_floor` |
| Succeeded | `cache`, `alias`, `resolved`, `decomposed` |
| Degraded | `weak_match`, `transcript_blank` |
| Blocked | `budget`, `error` |

**Only `no_match` and `below_floor` link**, to `/platform/inbox?source=kora`.
`Kind.NeedsHuman()` returns true for exactly those two, and kora's own comment says
why the rest are excluded: "a weak match is a soft signal and a decomposition is a
known-imprecise answer, but neither is something an operator can act on; putting
them in a triage queue would bury the two that are actionable."

So **eight of ten have no destination**. They render unlinked, with no tooltip
promising one. Linking them would have shipped eight dead ends — the same defect as
yesterday's tile promising a kora-filtered inbox before the inbox could filter.

`no_match` sorts ahead of `below_floor` and carries a "high" badge to its "normal",
matching the inbox's own severity: a gap ended the attempt with nothing, while a
near-miss at least gave the user something to correct.

All ten render including zeros — a kind dropped for being 0 hides that kora
measured it and found none. An "Other" group catches any kind kora adds later, so
an eleventh cannot vanish silently.

The taxonomy was verified against `kora/api/internal/resolveoutcome/model.go` and
`docs/resolution-outcomes.md` rather than inferred.

## Verification

- `vitest run` — 155 files / **2539 tests** (2524 before, +15)
- `packages/*` `test:unit` (6 packages), `packages/*` `typecheck` — clean
- `tsc --noEmit`, `eslint --max-warnings 0`, `next build` — clean

TDD throughout: 12 tests written first and confirmed failing for the right reason.

## Out of scope

Individual outcomes for the eight unlinked kinds. The data exists in kora's
`food_resolution_outcomes` — `phrase` (what the user said), `top_score`,
`candidate_count`, `tier` — but only the two actionable kinds are projected to the
inbox. Widening that is an upstream ask on kora, and `phrase` is user-entered text,
so it is a privacy decision as much as an API one.
