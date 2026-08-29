---
slug: kora-user-names
part: 2
created: 2026-08-29
status: in-progress
---

# Users-table filters, and `by_kind` as a diagnosis

Same branch. Part 1 put names on the user rows and pinned the pagination
conventions. This makes the surface usable.

## C. Search and activity filters on the users table

**The constraint that shapes this.** Kora's `ai-metrics` accepts only
`from`, `to`, `page`, `limit` — there is no server-side search or activity filter,
and unknown parameters are rejected. So both filters operate on the page already
fetched.

**The trap, and it is the important part.** An operator filters, sees 3 rows, and
the pager still reads "1–50 of 500". They conclude 3 users match. In fact 3 match
*on this page*. That is the same lie as a short inbox queue reading as "nearly
done" — a windowed view presenting itself as authoritative.

Requirements:

1. **Search** matches the user's joined name and email (available since part 1)
   **and** the raw id, so a UUID pasted from elsewhere still finds its row.
2. **Activity toggles** over the per-user fields that exist: has corrections, has
   budget refusals, has AI calls. Do NOT invent a "needs human" toggle — that is
   an aggregate on `outcomes`, not a per-user field.
3. **When any filter is active, the pager must stop claiming an unfiltered total.**
   Either state the filtered count against the page ("3 of 50 on this page"), or
   suppress the total. What it must never do is show a filtered list beside a
   total that counts unfiltered rows across all pages.
4. **Use `resolveState`'s existing `filtered` flag**, so a filtered-empty result
   renders "no results — clear filters" rather than the empty-state copy that says
   there is nothing here. The distinction already exists in the kit; use it.
5. Filters live in the URL, like every other console surface, so a filtered view is
   linkable and survives a reauth round-trip.

State the page-scoped limitation in the UI, not only in a comment.

## D. `by_kind` as a diagnosis, not ten flat rows

Today it renders ten equal numbers in declaration order. It is actually **why each
resolution attempt ended**, and the kinds drive different fixes — kora's own words:
`transcript_blank`, `error` and `no_match` are kept distinct "because all three
drive different fixes".

**Group by what an operator does about them:**

| Group | Kinds | Meaning |
|---|---|---|
| Needs attention | `no_match`, `below_floor` | index problems |
| Succeeded | `cache`, `alias`, `resolved`, `decomposed` | worked; `alias` is a previous correction paying off |
| Degraded | `weak_match`, `transcript_blank` | real signal, deliberately not triageable |
| Blocked | `budget`, `error` | not resolver quality — budget limits and provider faults |

**Link ONLY `no_match` and `below_floor`, and only to `/platform/inbox?source=kora`.**

This is the load-bearing constraint. `Kind.NeedsHuman()` returns true for exactly
those two, and kora's comment says why the others are excluded: "a weak match is a
soft signal and a decomposition is a known-imprecise answer, but neither is
something an operator can act on; putting them in a triage queue would bury the two
that are actionable."

So **eight of the ten kinds have no destination**. Linking them anyway would ship
eight dead ends — the same defect as promising a kora-filtered inbox before the
inbox could filter. Render those counts unlinked. Do not invent a destination.

`no_match` is `high` severity in the inbox and `below_floor` is normal, because a
gap ended the attempt with nothing while a near-miss at least gave the user
something to correct. Reflect that ordering; do not present them as equivalent.

Keep rendering all ten including zeros. A kind dropped because it is 0 hides that
kora measured it and found none.

## Verification — all six

`vitest run`, `packages/*` `test:unit`, `packages/*` `typecheck`, `tsc --noEmit`,
`lint` (`--max-warnings 0`), `next build`.

## Out of scope

Exposing individual outcomes for the eight unlinked kinds — the data exists in
kora's `food_resolution_outcomes` (`phrase`, `top_score`, `candidate_count`,
`tier`) but only the two actionable kinds are projected to the inbox. Widening
that is an upstream ask on kora, and `phrase` is user-entered text, so it is a
privacy decision as much as an API one.
