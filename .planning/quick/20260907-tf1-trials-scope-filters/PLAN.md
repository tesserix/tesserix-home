# The Trials tab says what it is showing

An operator looked at Billing → Trials, saw "Nothing here yet", and knew of a
tenant on a trial. The list was correct; **its scope was invisible.**

The tab applies a **7-day expiry window** (`DefaultExpiryWindow`) and excludes
Stripe-managed trials, and says neither on screen. A 90-day trial
(`TrialDays = 90`) is therefore absent from this tab for about twelve weeks,
which is right and reads exactly like a broken page.

## The fix is to show the scope, not to widen it

The narrow scope is deliberate and earns its place: the ordering is
soonest-first, there is a payment-method column, and Stripe-managed rows are
excluded because they **convert** rather than expire. `platform-api`'s own
comment calls it *"a work queue, not a report"*. That framing is worth keeping.

What is not defensible is applying it silently. So: **keep the work queue as the
default, and make it a visible, changeable filter.**

- The tab stays **"Trials"**. Renaming it to "Expiring trials" was considered
  and rejected — it makes the label honest while leaving the operator with no
  way to see the other trials, and the label stops being ambiguous anyway once
  the active filter is on screen.
- Two filters: **Expiring** (`Next 7 days` · `Next 30 days` · `Any`) and
  **Product**.
- The empty state names the active filter, which is the sentence that would
  have answered the original question instantly.

## What already exists — most of this is wiring

- **Product filter, backend-complete.** platform-api accepts `?source=<slug>`
  on `/v1/billing/trials` and narrows the fan-out to one product. The console
  has never sent it.
- **`include_stripe_managed=true`** is plumbed end to end already.
- **mark8ly is ready for a wider window.** `ListExpiring` takes `days`, clamped
  by `MaxExpiryWindow = 365d`, and computes `total` over *"THIS list's own
  scope, not via CountExpiring"* — with a comment stating `CountExpiring` keeps
  the narrower meaning for the KPI *"which must not move just because the list
  widened."* This exact change was anticipated.

**The one real gap:** platform-api's `trialsPath()` forwards `limit` and
`include_stripe_managed` but **not `days`**.

## Decisions

### 1. Default stays 7 days

The landing state remains the work queue. It is also what keeps
`/admin/kpis`'s `trials_expiring` counter and this list agreeing — they share
`DefaultExpiryWindow` deliberately, *"so the two cannot report different
numbers for the same word."*

**The KPI must not follow the filter.** Widening the list is a view change, not
a redefinition of "expiring". Do not touch `CountExpiring`.

### 2. "Any" implies `include_stripe_managed=true`

A converting trial is still a trial. Offering "Any" while silently excluding
Stripe-managed rows would rebuild the same invisible-scope bug one level down.
The two travel together.

### 3. "Any" means "within a year", and the copy must not overclaim

`MaxExpiryWindow` is 365 days and an operator-extended trial can end beyond it.
So "Any" sends `days=365` and is **not** literally every trial. Label it
honestly and say so in a comment; do not write copy that promises all.

## Tasks

Each is one atomic commit. Tests first.

### T1 — platform-api forwards `days`

`billing/internal/service/service.go`'s `trialsPath()`, plus `Query`. Validate
and clamp at the boundary rather than trusting the caller; mark8ly clamps too,
but a surface that forwards junk and relies on the product to reject it is one
refactor away from forwarding junk somewhere that does not.

Update the route documentation block in `handler.go`, which lists the accepted
params — it will otherwise be wrong the moment this lands.

### T2 — the console sends the filters

`fetchEstateTrials` takes `{ source?, days?, includeStripeManaged? }`. Today it
hardcodes `limit` only. Keep the default call-site behaviour identical to
current production: `days` absent → the product's 7-day default.

### T3 — the filter bar

`useUrlFilters` + `FilterBar` from `components/kit/`. Filter state belongs in
the URL — that is what makes a deep link to "Mark8ly, next 30 days" work.

Note `useUrlFilters`'s `dropOnChange`: if this surface pages, narrowing a filter
while on page 3 lands the operator on an empty page 3, which on screen is
indistinguishable from "nothing matches". Check how this page pages and pass the
right params.

### T4 — the empty state tells the truth

Currently: *"No trials are expiring. Every product that answered has none."*

It must name the **active** scope — "No trials expiring in the next 7 days" —
and, when the window is not `Any`, say that a wider one exists. This sentence is
the actual fix for the reported confusion; the filters are what make it
possible.

Keep the *"that answered"* half: it is doing real work, distinguishing "no
trials" from "a product failed to answer", and `failures` renders alongside.

### T5 — a test that pins the scope on screen

Nothing currently asserts that the applied window is visible. Add tests: the
default filter renders as `Next 7 days`; changing it re-fetches with `days`;
the empty state names the active window; and the product filter sends `source`.

## Out of scope

- **Changing `DefaultExpiryWindow` or `CountExpiring`.** Decision 1.
- **The Subscriptions tab.** It is already unfiltered by status and accepts
  `plan=trial`, so "every tenant on a trial" has a home there today. If a
  preset shortcut is wanted, that is its own change.
- **Renaming the tab.** Decided against above.

## Global constraints

- **Comment accuracy** — this estate's documented recurring defect. Run the
  command before writing the sentence that describes it.
- Do not weaken an existing assertion. pnpm, and run from this worktree.
- The console is a client/server split: filters are a client concern, the fetch
  is server-side. Keep the boundary.
