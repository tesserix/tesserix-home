---
id: 260905-cn1
slug: closed-newest-first
date: 2026-09-05
issue: "#565"
kind: quick
---

# The Closed tab, newest-closed-first

`closedOpportunities` sorts `COALESCE(o.closed_at, o.updated_at) ASC`, so an
operator opening the tab lands on the deal closed longest ago. The tab exists to
answer "what did we close, and what did we lose" — both retrospective questions
that want the most recent first.

## The reason recorded when this was filed is false

`crm-repo.ts:648-652` says newest-first "would be a second implementation of
[`queuePage`'s] backward mirroring rather than a flag". It is a flag, and the
proof is in the same file: **`listOrganisations` is already a descending keyset
read** with the identical structure. Side by side, the only differences are
three operator inversions:

| | `queuePage` (ASC) | `listOrganisations` (DESC) |
|---|---|---|
| preceding count | `backwards ? "<" : "<="` | `backwards ? ">" : ">="` |
| page predicate | `backwards ? "<" : ">"` | `backwards ? ">" : "<"` |
| ORDER BY | `backwards ? "DESC" : "ASC"` | `backwards ? "ASC" : "DESC"` |
| `trimForwardPage` / `trimBackwardPage` | identical | identical |
| `precedingCount` arithmetic | identical | identical |
| cursor codec | identical | identical |

The trim helpers are **direction-agnostic** — `keyset-cursor.ts:153-193` handles
*cursor* direction, not *sort* direction, and needs no change at all.

What `keyset-cursor.ts:88-95` actually argues is a READABILITY point — that a
shared helper taking a direction argument leaves "no reader able to tell what a
page means without also finding the argument". That is defensible and is
answered below; it is not a cost argument, and the filed issue overstated it as
one.

## The change

Add a **required** `direction: "asc" | "desc"` to `QueuePageQuery`
(`crm-repo.ts:341`), derive one boolean, and XOR it into the three ternaries at
`:417`, `:424`, `:432`:

    const flip = (direction === "desc") !== backwards;

Required, not optional-defaulting-to-asc, precisely to answer the readability
objection: every call site then states its own order where a reader is already
looking. `dueOpportunities` and `driftingOpportunities` pass `"asc"`;
`closedOpportunities` passes `"desc"`.

Rejected alternatives: a reversed sort key (`ORDER BY -extract(epoch …)`) breaks
the cursor codec's `Date.parse` validation (`keyset-cursor.ts:126`) and the
`closed_sort` column contract; a separate `closedOpportunitiesDescending` is the
second implementation the comment feared and is genuinely worse.

## Done when

The Closed tab opens on the most recently closed deal, backward paging still
works, and both work queues are **byte-identical in their emitted SQL**.

## What must NOT change, and is the regression proof

- `crm-repo.test.ts:91` "breaks an ordering tie on id, in both queues" — asserts
  `ORDER BY o.next_action_at ASC, o.id ASC` and the drifting equivalent.
- `crm-repo.test.ts:268` "flips the comparison and the ORDER BY for a backward
  cursor, in both queues" — asserts `(o.next_action_at, o.id) < (` and
  `ORDER BY o.next_action_at DESC, o.id DESC`.

Both must pass **untouched**. If either needs editing, the flag defaulted wrong.

## What legitimately changes

- `crm-repo.test.ts:657` — asserts `COALESCE(o.closed_at, o.updated_at) ASC`;
  becomes `DESC`.
- `crm-repo.integration.test.ts:2208` "returns only terminal deals,
  oldest-closed-first" — name and expected order both invert. Its fixture
  (`:2182-2190`) has a 20-days-ago lost row placed deliberately oldest.
- `crm-repo.ts:645-652`'s doc comment, which currently states the claim this
  change disproves.
- `keyset-cursor.ts:88-95`, which should say the two implementations differ by
  **table and paging regime**, not by direction.

## Not in scope

No Go change: `closedOpportunities` reads Postgres directly and never the
`crm-queues.ts` seam — `closed-tab.tsx:26-32` says so ("a closed list is not
among its routes"). No migration.

## Verification

From the WORKTREE root (`pnpm --filter console` run from the primary checkout
tests the primary checkout and reports green against code without the change):

    pnpm --filter console lint
    pnpm --filter console typecheck
    pnpm --filter console test:unit
    pnpm --filter console build
