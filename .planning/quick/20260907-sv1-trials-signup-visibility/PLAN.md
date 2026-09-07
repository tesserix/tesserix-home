# The Trials tab shows tenants stuck at signup

The console half of mark8ly#797. An operator with three tenants saw an empty
trials list at every window, because all three sit at `status = 'signup'` and
the list requires `trialing`.

mark8ly#797 adds `IncludeSignup` — **off by default**, because
`ListOptions`'s contract says an omitted option can never widen a live result
set. This is the caller that opts in.

## Decision: the console opts in BY DEFAULT

The API stays opt-in; the console asks for signup rows on first load.

That is the whole point. A default that still excludes them leaves the reported
problem exactly as it was — three tenants, an empty page. And a tenant who
signed up and never completed checkout is not a lesser case for a work queue,
it is a *stronger* one: `expiry_cron` only touches `trialing` rows, so nobody
is chasing them and nothing will age them out.

The narrowing is still available and visible, as a filter.

## Decision: render the status, do not merge the populations

`Trial.status` is **already parsed** (`lib/billing.ts:54`) and has never been
rendered. The trials table shows Ends · Tenant · Plan · Payment method ·
Product.

The two populations need different actions:

| status | what it means | what an operator does |
|---|---|---|
| `trialing` | checkout completed, trial running | watch it convert, or chase the card |
| `signup` | **never completed checkout** | chase them to finish signing up |

Merging them into one undifferentiated list would trade one invisible scope for
another — the mistake #608 exists to stop repeating. Add the column.

**"Ends" needs care for a signup row.** `EndsAt` derives it from
`created_at + 90d`, and `expiry_cron` will never act on it, so the date is
*notional*. Do not render it identically to a real `trial_ends_at` without
qualification — a date that looks like a deadline nothing enforces is worse
than no date.

## Tasks

Each is one atomic commit. Tests first.

### T1 — forward `include_signup`

`platform-api/internal/modules/billing/`: `Query.IncludeSignup` →
`trialsPath()`, alongside `include_stripe_managed`. Add `?include_signup=true`
to the route doc block in `handler.go` — that block **does** enumerate params
here, unlike mark8ly's handler.

### T2 — the console asks for it

`lib/trial-scope.ts` and `fetchEstateTrials`. The default query gains
`include_signup=true`.

**This changes the default request**, which #608 deliberately kept
byte-identical to production. Say so in the comment, and say why the reasoning
differs: #608 was avoiding a second copy of a *definition* (`DefaultExpiryWindow`,
shared with the KPI). This is a caller choosing a scope the API offers, which
is a different act — no constant is duplicated and no KPI is touched.

### T3 — the Status filter

A third descriptor beside Expiring and Product: `Trialing and signup`
(default) · `Trialing only`. Use `FilterDescriptor.defaultValue`, added in
#608, so the default renders as selected and no unhonourable "All" option
appears.

### T4 — the Status column, and honest dates

Render `status` per row. For a `signup` row, qualify the Ends value so it does
not read as an enforced deadline.

### T5 — the empty state distinguishes the two reasons

Today it can only blame the window. With signup rows included by default, an
empty list means something narrower and more useful — say which:

- narrowed to `Trialing only`, and empty → name that, not the window
- signup included, widest window, still empty → no tenant is on a trial in any
  product that answered

Keep the *"that answered"* clause; `failures` still renders alongside.

### T6 — tests

Assert the outgoing request carries `include_signup` by default; that
`Trialing only` drops it; that the status renders per row; that a `signup`
row's date is qualified; and each empty-state branch.

**A test that the default query includes signup** is the one that pins the
decision above — without it, a future "tidy-up" silently restores the empty
page.

## Out of scope

- **Aging out `signup` rows.** mark8ly#797's follow-up: whether a tenant that
  never completes checkout should be expired, chased, or left alone is a
  product decision with billing consequences. Make it visible first.
- **The KPI.** `trials_expiring` keeps its narrow meaning; nothing here reaches
  `CountExpiring`.

## Precondition

mark8ly#797 must be **deployed**, not merely merged, before this ships — the
console deploys on merge, and `include_signup` on an old marketplace-api is
ignored, silently returning the same empty list. Verify the running image by
ancestry.

## Global constraints

- **Comment accuracy** — this estate's documented recurring defect.
- Do not weaken an existing assertion. pnpm, run from this worktree.
