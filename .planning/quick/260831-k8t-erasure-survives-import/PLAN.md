---
quick_id: 260831-k8t
slug: erasure-survives-import
date: 2026-08-31
issue: tesserix-home#226
---

# An erased contact must not be re-created by the next import

`erased_at` is written and never read. `eraseContact` nulls `email` and
`instagram_handle` — deliberately, because `crm_contacts_email_lower_uq` is
partial (`WHERE email IS NOT NULL`) and nulling frees the address for a
legitimate future contact at the same business. `findMatchingOrganisationId`
matches on exactly those two columns, so a re-import of the same person matches
nothing and `commitImport` **re-creates them as a new organisation with a fresh
opportunity**. The erasure is silently undone and the new row carries no trace.

## Decision already taken — implement this, do not re-litigate

**Salted hash, match-and-refuse only.** On erasure, retain a keyed hash of the
identifiers being destroyed; import hashes each incoming row and refuses any
that matches. The alternative considered and rejected was having erasure add a
suppression entry: simpler and it reuses a tested control, but it conflates
"forget me" with "do not contact me" — two different legal requests — and the
suppression list would itself have to retain the identifier.

## State of the data — established, do not re-derive

`crm_contacts`: **259 rows, 0 with `erased_at` set.** `crm_suppressions`: 0
rows. So this lands ahead of the first real erasure and there is nothing to
backfill. Do NOT write a backfill.

## Tasks

### Task 1 — migration 0041

`apps/web/db/migrations/0041_crm_erased_identifiers.sql`:

```sql
CREATE TABLE crm_erased_identifiers (
  identifier_hash text PRIMARY KEY,
  erased_at timestamptz NOT NULL DEFAULT now()
);
```

**No contact id, no organisation id, and that is the point.** A hash stored on
`crm_contacts` would tie it to an organisation and create a re-identification
path — the erased row still exists, named `[erased]`. This table retains the
minimum needed to refuse a match and nothing that can rebuild who the person
was or where they worked.

Comment it in migration 0029's register: what it is for, why it holds no
foreign key, and that `identifier_hash` is a keyed HMAC, not a bare digest.

**Apply to production before the PR merges** — migrations are manual here and
Kargo deploys on merge. State it in the SUMMARY so the reviewer knows.

### Task 2 — the hash

New module (suggest `apps/console/lib/db/crm-erasure-hash.ts`), `server-only`.

- **HMAC-SHA256 keyed by `CRM_ERASURE_HASH_KEY`**, not salt-then-hash. A
  per-row random salt cannot be matched against an incoming value, so the key
  is necessarily fixed and application-wide; HMAC is the correct primitive for
  a keyed comparison and does not invite a homegrown salt scheme.
- Hash email and instagram handle **separately**, one row each, so a person who
  returns under only one of them is still caught.
- **Normalisation MUST match `findMatchingOrganisationId` exactly**:
  `lower(trim(email))` and `normalizeInstagramHandle(handle)` then lowered.
  If the two disagree by even a trailing space the hash of an incoming row
  never equals the one recorded at erasure, and the feature silently does
  nothing — the exact failure class of #433. Import the same normaliser rather
  than reimplementing it, and pin the agreement with a test.
- Absent key → throw. See Task 3 for why that is the safe direction.

### Task 3 — record on erasure

`apps/console/lib/db/crm-erasure.ts`. Inside `eraseContact`'s existing
transaction, BEFORE the UPDATE nulls the columns, read the identifiers and
insert their hashes into `crm_erased_identifiers` (`ON CONFLICT DO NOTHING` —
erasing twice is idempotent, and `erased_at` is already `COALESCE`d for the
same reason).

**Fail closed when `CRM_ERASURE_HASH_KEY` is unset**: throw, and let the
erasure fail. An erasure that succeeds without recording the hash silently
loses the ability to enforce itself, and a "forget me" the next import undoes
is worse than a refused erasure the operator retries once the key is
provisioned.

Note the self-consistency in a comment: if the key is unset, erasure throws, so
no hashes are ever recorded, so the table is empty and import has nothing to
check. The two halves cannot disagree.

### Task 4 — refuse on import

`apps/console/lib/db/crm-repo.ts`. In both `previewImport` and `commitImport`,
before a row is used to create an organisation, hash its identifiers and check
`crm_erased_identifiers`. On a match, skip the row.

- Count it as **`skippedErased`, distinct from `skippedSuppressed`.** Different
  reason and different remedy: telling an operator to "remove the suppression"
  for someone who asked to be forgotten is wrong advice, and the copy for the
  suppressed case says exactly that.
- Preview and commit must agree, the way the existing counts already do —
  `counts.ts` documents the trap where preview and commit disagree about what
  was left on the floor.
- Surface the count in the import UI beside the existing ones.

### Task 5 — tests

- an erased contact's email re-imported → **skipped, counted as erased,
  organisation NOT created**. This is the whole issue; it must fail if the
  check is removed.
- same for the instagram handle alone
- a DIFFERENT person at the same organisation still imports — erasure must not
  become a business-level block
- erasing twice is idempotent, and the second erase does not duplicate a row
- **normalisation agreement**: a hash recorded from `" Foo@Example.COM "` is
  matched by an incoming `foo@example.com`. Assert against the real
  normaliser, not a copy.
- `CRM_ERASURE_HASH_KEY` unset → `eraseContact` throws, and nothing is written
- preview and commit report the same `skippedErased` count for the same file

Run `pnpm test` and `pnpm --filter console build`. A typecheck is not a build,
and this adds a `server-only` module.

### Task 6 — commit

Single line, conventional commits, no body, no signature. Suggested:
`fix(console): keep an erased contact erased when the next import contains them (#226)`

## Out of scope

- No backfill — there are no erased contacts.
- Do not change `eraseContact`'s existing nulling behaviour or the partial
  unique index; freeing the address for a future contact is deliberate.
- Do not touch the suppression list or its copy.
