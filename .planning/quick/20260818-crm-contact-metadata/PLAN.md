# Future-proof contact metadata, and filters that admit what they don't know

Two operator reports, one root cause: the CRM presents scrape-derived fields as
live filter axes while nothing can maintain them and NULL rows are silently
unreachable.

## Mahesh's decision

**Typed columns for anything filtered or sorted; a `jsonb` bag alongside for
raw scrape output worth retaining but not querying.** The standing rule, to be
written into the schema comment so it survives this PR:

> Promote a key out of the bag into a column when it becomes a filter axis.

Plus an **"Unknown" band** on both the follower and country filters, so NULL
rows stop being invisible.

## What is actually there

`crm_contacts` already carries **three** scrape fields, not one:
`followers_count`, `posts_count`, `biography`. None is written by any live path
— the only writer was the one-shot leads migration. CSV import doesn't map
them, the manual-add form doesn't offer them, the edit surface doesn't expose
them, and erasure nulls all three.

So "make followers maintainable" is really "make the three existing scrape
columns maintainable", and the bag is for whatever the next scrape adds.

## THE DPDP CONSTRAINT — read before writing any code

`crm_contacts` holds, in its own schema comment, *"scraped social profiles
about people who never filled in a form"*, with `source` / `sourced_at` /
`lawful_basis` recording what is held and why. `eraseContact`
(`crm-erasure.ts`) exists to satisfy erasure requests and today nulls
`biography`, `followers_count`, `posts_count` among others.

**A raw-scrape `jsonb` bag on this table is a new place for personal data to
hide from that erasure.** It is the single biggest risk this change
introduces, and it is not hypothetical: the bag's whole purpose is retaining
scrape output nobody has enumerated.

Therefore:

1. `eraseContact` **must** clear `metadata` in the same statement that nulls
   the other fields — not a follow-up write, not a later PR.
2. A test must assert that **no key survives** erasure: seed a contact whose
   bag holds several keys, erase, and assert the bag is `{}`. Asserting one
   named key is not enough — the bag is unenumerated by design, so the
   assertion has to be about the whole object.
3. Mutation-test it: remove the `metadata` clear, watch that test fail,
   restore. A DPDP guard that cannot fail is worse than none.

If any of this proves impossible, stop and report rather than shipping a
partial erasure path.

## Task 1 — schema, erasure, write paths

**Migration `0027_crm_contacts_metadata.sql`** (next free number; 0026 is the
latest). `metadata jsonb NOT NULL DEFAULT '{}'` on `crm_contacts` — NOT NULL
with a default so no reader has to special-case NULL versus empty, matching
`crm_activities.metadata` and `crm_organisations.category`/`tags`. The header
comment carries the promote-to-a-column rule.

**Erasure** — as above. Non-negotiable.

**Write paths for the three typed columns plus the bag:**

- CSV import: extend `IMPORT_COLUMN_MAP` (`lib/crm.ts`) and `commitImport`'s
  contact insert. A followers column in a spreadsheet is currently *silently
  ignored*; that stops.
  Validate: `followers_count`/`posts_count` are integers — a non-numeric cell
  must not abort the batch, but must not silently become 0 either. Follow the
  precedent `websiteUrl` set in #223 (store NULL, count it, report the count
  to the operator).
- `insertContact` (`crm-writes.ts`): accept and write all four.
- Keep the bag's write surface narrow: import may populate it; the manual
  forms need not offer free-form JSON entry.

**Do not fix the leading-`@` handle inconsistency here** — that is #236 and
stays out.

## Task 2 — filters that admit what they don't know

Both filters currently exclude NULL from every value with no way to select
those rows. Today that hides 51 organisations on followers and **208 of 259**
on country.

- Add an `unknown` sentinel to the follower bands and to the country filter,
  following the `NO_PRODUCT_VALUE` / `UNASSIGNED_PRODUCT` precedent already in
  `crm-filters.ts` rather than inventing a second convention.
- The predicate becomes `IS NULL` for that value. For followers, note the
  existing clause is scoped to the **primary contact only** — "unknown" must
  mean "the primary contact has no follower count", consistent with the bands,
  not "no contact anywhere has one".
- Label it so it reads as a data state, not a band: "Unknown", not "0".
- Both surfaces: the follow-up queue and the organisations browse.

## Verification

- Erasure: the whole-bag assertion above, mutation-tested.
- Import: a spreadsheet with a followers column populates it; a non-numeric
  cell is counted and reported, not silently zeroed.
- Filters: an org whose primary contact has no follower count is reachable via
  "Unknown" and absent from every numeric band; same for country. Assert the
  counts, since the bug is that rows go missing.
- Round-trip the bag through insert and read.

## Gates

`pnpm --filter console test:unit`, `typecheck`, `lint`, `build`. Integration
tests must load `0027` in the migration list. No new dependencies. Nothing
under `apps/web/app/admin/**`; the migration goes in `apps/web/db/migrations/`,
which is the established location for CRM schema and is not part of the admin
freeze.
