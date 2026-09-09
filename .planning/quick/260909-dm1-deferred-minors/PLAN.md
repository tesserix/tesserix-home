---
id: 260909-dm1
slug: deferred-minors
date: 2026-09-09
issue: 107
kind: quick
branch: fix/107-deferred-minors
---

# The deferred minors from #97, less the ones that have aged out (#107)

#107 is a record of defects that were known and deliberately left during the
Track A fixes, kept because the SDD ledger was deleted at teardown. Each was
re-checked against the code before being planned here rather than taken from
the issue text.

## Measured starting state, 2026-09-09

| #107 item | State on `main` |
|---|---|
| `support/page.tsx` raw `{d.date}` | **still present**, line 846 |
| `staff/page.tsx` total stated twice | **still present**, lines 142 and 294 |
| `delivery/page.tsx` link distinguished by `title` only | **still present**, line 112 |
| `audit-logs/route.ts` error log interpolates `product` | **already fixed** — line 178 now interpolates `source` |
| `support/page.tsx` three near-identical table blocks | still present; **not in this batch**, see below |

## What these surfaces are

`/admin/apps/homechef/*` has no console equivalent — the console's route tree
carries `kora`, `mark8ly`, `platform` and nothing for homechef. So under
ADR-003 / #272 these pages are not yet retirable, and they are what operators
use today. Fixing them is not investment in dead code.

## Tasks

1. **`support/page.tsx`: format the meal-plan day.** `{d.date}` renders raw
   while every other cell in the file goes through a formatter.

   #107 says to use `formatDateTime`, and that is wrong here. The peers it
   refers to format `createdAt`, a timestamp. `DayDeliveryFailure.date` is a
   calendar day — the mobile surface over the same payload renders it
   date-only (`apps/mobile/app/homechef/delivery-failures.tsx:154`), and
   `formatDateTime` would append a meaningless "12:00 am". Use `formatDate`,
   which is already exported from `@tesserix/homechef-shared` and, unlike the
   raw render, returns "—" for a null or unparseable value.

   Done when: the cell reads as a date, matches the mobile peer, and an empty
   `date` shows "—" rather than blank.

2. **`staff/page.tsx`: state the total once.** The header says "N team
   members" and the pagination footer repeats it as "N team members · page X
   of Y". Keep the total in the header, where it is the page's subtitle, and
   reduce the footer to its pagination context.

   Done when: the total appears once on the page and the footer still says
   which page of how many.

3. **`delivery/page.tsx`: make the link's caveat visible.** The delivery
   intelligence link explains itself only through a `title` tooltip, which
   never appears on touch and is skipped by most screen-reader flows. Replace
   it with adjacent muted text, so the "separate system from these 3PL
   couriers" caveat is readable without hovering.

   Done when: the caveat is visible without hover and no meaning is carried by
   `title` alone.

## Deliberately not in this batch

**The 972-line `support/page.tsx` refactor** (extract `DeliveryFailureSection`
/ `FaultButtons` from three near-identical table blocks). It is the largest
item in #107 and the only one that is a refactor rather than a defect. ADR-003
retires `/admin/**` by deletion rather than migration, and #272's standing
constraint on these surfaces is "do not touch". Restructuring 300-odd lines of
a file scheduled for deletion, with no tests over it, buys little and risks a
live operator surface. Flagged for a decision rather than done silently — the
file exceeding the 800-line guideline is real, so this is a judgement call and
not a refusal.

**The `0016_seed_dwellm8_app.sql` verification.** Not a code change; it needs a
database read, and is tracked separately in the issue as unverified.

## Verification

`pnpm --filter web build`, `tsc --noEmit`, and the existing unit suites. These
three pages have no tests of their own; each change is checked by reading the
rendered output rather than by a new test asserting the string.
