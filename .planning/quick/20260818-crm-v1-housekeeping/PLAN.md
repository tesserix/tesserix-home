# CRM v1 housekeeping (#228)

Seven items parked during #223. **Every claim was verified against current
`main` (`5bc336b`) before planning, and four were wrong.** What follows is the
corrected scope, not the issue's wording.

## Corrections to the issue

| Item | Issue says | Actually |
|---|---|---|
| 1 | "add a unique constraint and the comment becomes true" | **Impossible.** The window is `crm_contacts` ↔ `crm_suppressions` — cross-table. No unique index can enforce "absent from another table". 0023's index closes a *different* race (duplicate contacts, #215). Fix = correct the comment. |
| 2 | verify no stale "never re-displayed" wording survives | **Already correct in source.** One stale copy survives, in `docs/superpowers/plans/2026-08-17-crm-v1-gaps.md:1055` — a historical plan record, left as-is. Item closes as a verification, no code change. |
| 3 | "`createContact`'s standalone path is untested" | **Refuted.** Two integration tests cover it (`crm-writes.integration.test.ts:246-267`). Coverage is *thin*, not absent — the gap is persisted contents and duplicate-key behaviour. |
| 5 | "truncation is untested" | **There is no truncation to test.** `ProductsCell` emits an unbounded comma-joined string. Fix = add the behaviour, then test. |
| 7 | dead guard in `NewOpportunityForm`, "consistent with `ActivityComposer`" | **Both wrong.** Neither has such a guard. The dead guard is in **`NewContactForm`** (`organisation-detail-view.tsx:775`) against its button at `:850`. |

Also found and filed separately as **#236**: `insertContact` stores an
Instagram handle without stripping `@` while the suppression check normalises
it. A behaviour bug, out of scope here by the issue's own framing.

## Decisions (confirmed with Mahesh)

- Item 1 → **correct both comments**, no behaviour change.
- Item 5 → **add truncation, then test** — honour the issue's reasoning ("an
  organisation with many products is exactly the row an operator scans")
  rather than its literal wording.
- The `@` bug → **filed separately**, not swept in here.

## Task A — the writes cluster (items 1, 3, 6)

Files: `crm-writes.ts`, `organisations/new/actions.ts`,
`[organisation]/actions.ts`, `crm-writes.integration.test.ts`,
`crm-writes.test.ts`, both `actions.test.ts`.

**Item 1 — correct two overclaiming comments.** Both copies:
`crm-writes.ts:177-182` (on `createContact`) and `:41-44` (on the helper).
They claim a shared client closes a TOCTOU window on the suppression check.
Under `READ COMMITTED` it does not: a suppression committed after the
`SELECT` is still invisible to the `INSERT`. State what the shared client
actually buys (a consistent snapshot for the checks made *within* the
transaction, and not burning a second connection from a `max: 2` pool) and
that the window remains open. Do not overcorrect into claiming a guarantee in
the other direction.

**Item 3 — deepen `createContact` coverage.** Not "add the missing test" —
add what the two existing tests don't reach: the persisted row's contents
(name, phone, `is_primary`, normalised email) and duplicate-key behaviour
against `crm_contacts_email_lower_uq` / `crm_contacts_instagram_lower_uq`.
Do **not** fix or test the `@`-stripping discrepancy — that is #236.

**Item 6 — a duplicate contact must say so.** Today a `23505` on either
unique index propagates untouched through `withCrmWrite` to the generic
`"That change was not saved."`, on both manual-create doors
(`createOrganisationAction`, `addContactAction`). The import path resolves
the same condition informatively as `matchedExisting`
(`crm-repo.ts:1145-1160`).

Raise a typed error from the data layer on `23505` (mirroring
`SuppressedContactError`'s shape) and allowlist it via `mapError` alongside
`mapSuppressedContact` on both actions. The message must tell the operator
the contact already exists and by which key — without leaking which
organisation holds it, which is a different tenant's data. Match
`SuppressedContactError`'s wording register.

## Task B — render test + dead line (items 4, 7)

Files: new `organisations/new/page.render.test.tsx`,
`organisation-detail-view.tsx`.

**Item 4 — prove the Radix `Select` reaches `FormData`.** The mechanism is
asserted only in a comment (`organisations/new/page.tsx:134-141`); no render
test for that page exists. Render it, choose a product, submit, and assert
the mocked action received `product` in its `FormData`. This is the test that
fails if a future primitive change stops mirroring to the hidden native
`<select>`.

**Item 7 — delete the dead guard.** `NewContactForm.submit`'s `if (!hasField)`
(`:775-778`) is unreachable: the button (`:850`) is already
`disabled={pending || !hasField}` and the form has no other submitter. The
server action re-checks the same condition and returns the identical string
(`[organisation]/actions.ts:324-326`), so the rule is still enforced where it
matters. Delete the guard; keep `hasField` itself (the `disabled` prop uses
it).

## Task C — ProductsCell overflow (item 5)

Files: `organisations-view.tsx`, `organisations-view.test.tsx`.

`ProductsCell` (`:87-90`) currently emits `products.join(", ")` unbounded into
a `TableCell` with no `truncate`, `max-w-*`, `line-clamp` or `title`.

Show the first few products, then a `+N more` remainder, with the full list in
a `title` so nothing becomes unreachable. Keep the existing empty state (an
em-dash in muted text). Tests: empty, one, exactly at the cut, and well over
it — the last being the row this item exists for.

## Gates

`pnpm --filter console test:unit`, `typecheck`, `lint`, `build`. CI does not
run typecheck (#231), so it must pass locally.

**No new dependencies** — each one also needs a `COPY` line in both
Dockerfiles, and a missing one fails the image build while every local gate
stays green.
