---
slug: kora-user-names
date: 2026-08-29
status: complete
---

# Names on `/kora/ai-metrics`, and a guard for yesterday's bug

| | |
|---|---|
| `7a85b7a` | `feat(console)`: join kora ai-metrics user rows to their name via one entities read |
| `912ea99` | `test(console)`: pin platform-api's two pagination envelope conventions per producer |

## A. Names instead of UUIDs

The per-user table rendered `ce9afd1e-2c5f-4e21-83e3-540a85479ea7`. Kora's
`ai-metrics` payload carries only `user_id`, so the name comes from a second read
the console already makes — `GET /v1/entities/users?source=kora`, where Kora sends
the handle as `label` and the email as `sublabel`.

**One extra read, not one per row.** A page of users is fetched once, mapped by id.

**The unmatched case is the one that mattered.** There is no id-filtered entity
lookup — `entityParameters` is `source, q, limit, page`, unknowns rejected — so the
join can only name users inside the fetched page. Where no match is found the row
renders **the raw id**, never "Unknown user": "outside the fetched page" and "does
not exist" are different facts, and a placeholder renders them identically. Same
rule `formatFirstTryRate` (absent ≠ 0%) and `lastActivityAt` (absent renders `—`,
never "Never") already apply on this surface.

The name read narrows independently: if it fails, the metrics table still renders
with raw ids rather than blanking.

The long-term fix is Kora returning a label on `ai-metrics` itself, which would
delete the join. Different repo, not this task.

## B. Pin which pagination convention each client expects

Yesterday `/kora/ai-metrics` shipped broken and six green gates missed it. The
cause was not carelessness — it was that **platform-api has more than one
pagination convention**, and the console guessed.

The audit found **three** shapes, not the two the plan predicted:

| Producer | Where pagination lives | Console reads it via |
|---|---|---|
| `entities` (`service.go:137`) | inside `data` | `platformRequest` → `parseEntities` |
| `koraaimetrics` (`handler.go:86`, `WriteMeta`) | envelope `meta` | `platformRequestWithMeta` |
| crm queues | cursor-based `meta` (`total`, `preceding_count`, `next_cursor`, `previous_cursor`) | `parseQueuePage` — already correct, structurally distinct |

`/kora/ai-metrics` was written by pattern-matching `/kora/foods` and `/kora/users`,
which use the first. Its producer uses the second. The fixture asserted the first,
so parser and tests agreed with each other and both disagreed with the producer —
and a passing test named *"refuses a response with no pagination"* asserted
production's failure as correct behaviour.

Each client's fixture now names the convention it expects, so the claim is written
where a reader can check it.

Also confirmed out of scope: `tools-directory.ts`, `health.ts`,
`tenant-lifecycle-write.ts` and `tools-write.ts` never parse pagination from `meta`;
`billing.ts`, `inbox.ts`, `ai-usage.ts` and `support-analytics.ts` read a bare
`total` from `data` rather than a page triple.

## Verification

- `vitest run` — 155 files / **2524 tests**
- `packages/*` `test:unit`, `packages/*` `typecheck` — clean
- `tsc --noEmit`, `eslint --max-warnings 0`, `next build` — clean

## The lesson

A fixture is a claim about what another system sends. Hand-written, it can agree
with the parser and disagree with reality — and every gate downstream inherits the
same wrong assumption, including a test that names the failure and asserts it is
correct.
