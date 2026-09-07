---
id: 260907-ps1
slug: promo-scoping
date: 2026-09-07
issue: 593
kind: quick
branch: feat/promo-scoping-593
---

# Promo codes carry campaign scoping, and only campaign scoping (#593)

A console-authored promo code applies to every plan and every billing period,
because the published contract cannot say otherwise. mark8ly has the columns;
the console has no field for them, so every ingested code inherits mark8ly's
defaults whether or not those suit the campaign.

This implements **Option 3**, recommended on the issue 2026-09-06 and settled:
publish `allowed_plans` and `annual_only`; keep `max_per_email` and
`min_effective_price_per_currency` as mark8ly-side policy the console cannot
weaken.

## Verified before planning, not taken from the issue

- **The plan vocabulary is `starter` | `studio` | `pro`, lower-case, in both
  repos.** mark8ly: `internal/billing/pricing/catalog.go:41-43`. Console: the
  same three tokens inside every `mark8ly_<plan>_<period>_…_v1` lookup key.
  A constraint written against `Starter` would scope every code to nothing
  while looking correct on both surfaces.
- **mark8ly's columns exist and are the target shape.** `allowed_plans TEXT[]`
  (NULL = all) and `annual_only BOOLEAN NOT NULL DEFAULT FALSE`,
  `migrations/000060_promo_codes.up.sql:24-27`. This work does not invent a
  shape; it fills two columns that have been sitting unfillable.
- **The contract already declares additive change safe.** `route.ts`'s module
  doc: "ADDITIVE CHANGES ARE THE ONLY SAFE ONES". Two new keys is that.
- **`revision_id` is a content hash over the served body**, so adding fields
  moves it once, every consumer revalidates, and nothing is stale. This is a
  property to rely on, not a risk to mitigate.
- **The live code `SAVEOFFER20OFF6MONTHS` is currently unscoped** and must stay
  that way through this change — `allowed_plans` NULL is the correct existing
  value, not a backfill target.

## Decisions, settled — do not re-open these

1. **`max_per_email` and `min_effective_price_per_currency` are NOT published
   and NOT authorable.** They are abuse controls (§7.3, §7.4), not campaign
   shape. An authoring UI that can raise `max_per_email` is an authoring UI
   that can switch off an abuse control, through the same form and the same
   permission as an ordinary campaign edit. Widening that policy is a mark8ly
   change with its own review. **Write this in the migration header and the
   route docstring**, because the next person to look at the gap will read the
   code and not the issue.
2. **`annual_only boolean`, not `allowed_periods text[]`.** The symmetric array
   is the nicer shape and is deliberately rejected: mark8ly can only express
   `annual_only`, so a console field for "monthly only" would author a
   restriction no redeemer applies — a control that reads as enforced and is
   not. Mirror what the redeemer can honour. Record the asymmetry rather than
   papering over it.
3. **NULL means "every plan", and the empty array is unstorable.** `{}` would
   be a code no plan can redeem, which is what `is_active = false` already
   says. Two spellings of one fact is two branches in every reader — 0043's
   standing argument, and 0046's for `max_redemptions > 0`.
4. **The plan vocabulary is CHECKed, not free text.** A typo'd `prro` is a code
   that silently applies to nothing, is accepted at authoring, renders as
   scoped on every surface, and is discovered by a merchant who cannot redeem.

## THE LESSON THIS TASK EXISTS UNDER

#593 exists because a field mark8ly could express and the console could not
resulted in a real code shipping with defaults nobody chose. The mirror of that
failure is the one to avoid here: **publishing a field the console can author
and mark8ly does not read** is the same defect pointing the other way, and it
would be invisible from this repo entirely.

So T5 is not optional bookkeeping. The console half is not done when the
contract serves the keys; it is done when the counterpart issue exists in
mark8ly naming the exact fields, the exact vocabulary, and the GORM
`serializer:json` on a `text[]` column (`internal/promo/model.go:54`) that the
ingest will have to be checked against.

## Tasks

- **T1 — migration `0051_promo_codes_scoping.sql`.** Add `allowed_plans text[]`
  and `annual_only boolean NOT NULL DEFAULT false`. Constraints: plan values
  from the closed vocabulary, no NULL elements, no duplicates, non-empty when
  present. Header carries decisions 1-3. Idempotent throughout (#509).
- **T2 — repository.** `promo-codes-repo.ts` reads and writes both columns;
  types extended. Integration tests assert the TypeScript against Postgres, not
  against a second hand-written expectation (0046's lesson).
- **T3 — authoring surface.** Fields in `promo-codes-panel.tsx`, validation in
  `promo-actions.ts`. Default is unscoped, and the UI says so in words rather
  than by an empty control.
- **T4 — contract.** Serve `allowed_plans` and `annual_only` on
  `/api/v1/promo-catalog`. Docstring records what is excluded and why
  (decision 1). Route tests assert the served body.
- **T5 — the counterpart.** Open the mark8ly ingest issue; update #593 with
  what shipped and what remains cross-repo.

## Done means

- [ ] A code can be authored Pro-only, annual-only, or both, and unscoped
      remains the default
- [ ] `/api/v1/promo-catalog` serves both keys; existing keys unchanged
- [ ] `SAVEOFFER20OFF6MONTHS` still reads as unscoped after the migration
- [ ] The abuse-control exclusion is stated in the schema AND the contract
- [ ] mark8ly counterpart issue open, naming fields, vocabulary and the
      `serializer:json` check
