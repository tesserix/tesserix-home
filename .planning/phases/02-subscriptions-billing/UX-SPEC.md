# UX Spec: Subscriptions, Dunning & Trial Management (Phase 2)

Surfaces: Subscriptions list (`/admin/apps/mark8ly/subscriptions`), Tenant Detail additions, and Mark8ly Overview Revenue section.

Design direction: Linear/Vercel-style data-dense admin — same as Phase 1. `@tesserix/web` (shadcn/Radix) primitives throughout. `recharts` for sparklines. WCAG 2.1 AA. The Phase 1 patterns (MetricsSection, KpiTile, SparklineCard, cost-honesty idiom) are extended, not replaced.

---

## 1. Surface 1 — Subscriptions List Page (`/admin/apps/mark8ly/subscriptions`)

### Page intent

"Are we making money, and where is the revenue at risk?" An operator arrives here to spot dunning failures, trial expirations approaching, and unexpected churn — not to browse a table. Summary tiles at the top answer the question before they even look at rows.

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  PAGE HEADER  "Subscriptions"    [Plan ▼] [Status ▼] [Refresh]  │
├─────────────────────────────────────────────────────────────────┤
│  SUMMARY TILES  (4-up)                                          │
│  [Total MRR]  [Trials]  [Past due]  [Cancelled this month]      │
├─────────────────────────────────────────────────────────────────┤
│  FILTER BAR  (chips, inline)                                    │
│  [All] [Dunning only] [Trial only] [Active only]               │
├─────────────────────────────────────────────────────────────────┤
│  TABLE  (sortable columns — see column spec below)              │
│  Tenant · Plan · Status · MRR · Period end · Dunning · LTV      │
└─────────────────────────────────────────────────────────────────┘
```

The Refresh button in the page header follows Phase 1's `RefreshControl` pattern exactly. No `TimeWindowPicker` is needed here — subscription data is current-state, not time-windowed.

### Summary tiles (4-up)

Reuse `KpiTile` in a `grid grid-cols-2 gap-4 lg:grid-cols-4`.

| Tile | Value | Delta/hint |
|---|---|---|
| Total MRR | `$X,XXX` | `+$YYY vs last month` |
| Trials | `N` | `N expiring in 7 days` |
| Past due | `N` | colored amber if > 0 |
| Cancelled this month | `N` | `N same period last month` |

"Past due" tile: the value itself uses `text-amber-600` when the count is non-zero. This is the only summary tile that changes text color by state — all others remain `text-foreground`. Delta pill uses the existing delta pill pattern from Phase 1 KpiTile.

Total MRR tooltip (Radix `Tooltip`): "Sum of monthly plan prices for all `active` and `trialing` subscriptions. `past_due` subscriptions are excluded until payment clears. Uses placeholder pricing from `lib/products/configs.ts`." Add the `Info` icon trigger exactly as in Phase 1's cost section.

### Column spec and default sort

Default sort: `current_period_end` ascending — surfaces the most urgent rows (soonest renewal / expiry) without requiring any action.

| Column | Content | Sortable | Notes |
|---|---|---|---|
| Tenant | Name + subdomain in `text-xs text-muted-foreground` | Yes | Links to `/admin/apps/mark8ly/tenants/{id}` |
| Plan | `PlanBadge` component | Yes | See badge taxonomy section |
| Status | `StatusBadge` component | Yes | See badge taxonomy section |
| MRR | `$XX` tabular-nums | Yes | `—` for `trial` |
| Period end | Relative: "in 3 days" + absolute in tooltip | Yes | |
| Dunning | Inline indicator — see below | No | Only populated for `past_due` / `unpaid` |
| Lifetime value | `$X,XXX` | Yes | From `billing_archive.total_revenue_usd` or summed webhook events |

Column width allocation: Tenant gets the most space (flex grow), Plan and Status are fixed-width badges, numeric columns are right-aligned with `tabular-nums`.

**Dunning indicator:** For `past_due` / `unpaid` rows, show an amber dot + text like "Retry 2 of 4 · last attempt 2d ago". For `active` and others, this cell is empty. Do not show the column header "Dunning" with a value in every row — the empty state communicates "no issue" more cleanly than "N/A" repeated.

### Trial columns (conditional)

When "Trial only" filter chip is active, two additional columns inject between Status and MRR:

- **Trial ends** — "in N days" (red text for ≤ 3 days, amber for ≤ 7, muted for > 7)
- **Likelihood** — a signal chip: "High / Medium / Low" with a muted background. This is a heuristic proxy (e.g., store has products uploaded, received an order) surfaced as a label, not a percentage. Tooltip explains the basis: "Based on store setup completeness and activity signals. Not a predictive model."

Column injection is purely additive — the table does not reflow other columns, it prepends these two after Status. On narrow viewports the table scrolls horizontally; these columns are not hidden on mobile.

### Filter chip placement and behavior

Filter chips sit between the summary tiles and the table — not in the page header. They are `Button variant="outline" size="sm"` toggles in a `flex flex-wrap gap-2`. Only one of "Dunning only" / "Trial only" / "Active only" can be active at a time (single-select); "All" is the default and deactivates the others. This avoids a conflicting multi-select state (e.g., "Dunning only" AND "Trial only" is nonsensical — dunning implies non-trial).

Aria: wrap the chip group in `<div role="group" aria-label="Filter subscriptions">`. Each chip `Button` has `aria-pressed={isActive}`. Below the group, add `<p role="status" aria-live="polite" className="sr-only">{filteredCount} subscription{filteredCount !== 1 ? 's' : ''} shown</p>`. This element is visually hidden but announces to screen readers when filters change.

### Plan and Status filter dropdowns

Two `Select` components (from `@tesserix/web`) in the page header right zone, matching `TimeWindowPicker` visual style from Phase 1. "All plans" and "All statuses" are the defaults. These combine with the filter chips (AND logic): "Trial only chip + Starter plan" shows trials on the starter plan.

### Sortable column headers

Use `<button>` elements inside `<th>` with `aria-sort="ascending" | "descending" | "none"`. Active sort column shows a `ChevronUp` or `ChevronDown` Lucide icon inline. Screen reader reads: "Tenant, column header, sort ascending button." Tab order flows left to right across column headers before entering the row data.

### Mobile / narrow viewport behavior

At viewport < 768px, the table becomes a card-stack list. Each card shows: tenant name (large), plan badge, status badge, MRR, and period end. Dunning indicator appears as an amber banner below the status badge if present. Sorting and filtering chips remain available above the list; columns that don't fit a card are accessible via an expandable "More" row within each card (Radix `Collapsible`). Do not attempt to scroll a 7-column table on a 375px screen — the card-stack is the correct degradation.

### Empty state

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   No subscriptions yet.                                 │
│   Subscriptions will appear here once mark8ly tenants   │
│   complete onboarding and activate a plan.              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

If a filter is active and produces zero results: "No subscriptions match the current filters." with a "Clear filters" link. Never show the generic "No subscriptions yet" copy when a filter is responsible for the empty result.

### Loading state

Summary tiles: `Skeleton w-16 h-8` for value, `Skeleton w-24 h-3` for label — same as Phase 1. Table rows: 5 skeleton rows each with `Skeleton` matching column widths. No full-page spinner.

### Error state

If the API call fails, replace the table body with the same inline destructive-bordered block used in Phase 1 tenants list. Keep the summary tiles visible with `—` values and a stale-data timestamp in amber, same pattern as Phase 1.

### Gating for future products

The Subscriptions page is gated by `ProductConfig.features.subscriptions: boolean`. If `false` (e.g., HomeChef has no subscription model), the sidebar nav item is hidden and the route returns a "Not available for this product" placeholder. This is a `ProductConfig` flag, not a runtime check.

---

## 2. Surface 2 — Tenant Detail Additions

Two new `MetricsSection` blocks appended after the existing Section D (Estimated Cost Share). Sections E and F respectively.

### Layout addition

```
┌─────────────────────────────────────────────────────────────────┐
│  ... existing sections A–D (Identity, Activity, Email, Cost) ...│
├─────────────────────────────────────────────────────────────────┤
│  SECTION E — Subscription                                       │
│  [Plan badge] [Status badge]  |  Period start → end  [countdown]│
│  [Next invoice amount + date]                                   │
│  [State-specific panel — trial / past_due / canceled / etc.]   │
│  [Plan change timeline — last 3 inline + "View all" expansion] │
│  [Lifetime value]                                               │
├─────────────────────────────────────────────────────────────────┤
│  SECTION F — Estimated Margin                                   │
│  [Monthly margin $] [Margin %]                                  │
│  3-up breakdown: revenue · infra cost · margin                  │
│  Allocation note (same info-icon honesty as Phase 1 cost)      │
└─────────────────────────────────────────────────────────────────┘
```

### Section E — Subscription anatomy

**Header row:** `PlanBadge` + `StatusBadge` sit inline after the section title "Subscription", space-separated. This means the most important state information is visible even before reading the section body.

**Period band:** A single line beneath the badges:
```
Nov 1, 2025 → Dec 1, 2025  ·  renews in 12 days
```
"Renews in N days" is `text-amber-600` when N ≤ 7, `text-red-600` when N ≤ 2, muted otherwise. For `cancel_at_period_end: true` it reads "cancels in N days" in `text-amber-600` always.

**Next invoice:** `$XX.00 · Dec 1, 2025`. If Stripe hasn't surfaced an upcoming invoice (e.g., `canceled`, `incomplete`), show `—`.

**State-specific panel** — this block changes entirely based on status. It sits between the period band and the plan timeline. It is never empty but its content is conditional:

| Status | Panel content |
|---|---|
| `active` | Nothing — no extra panel needed. Clean. |
| `trialing` | "Trial ends in N days" counter (colored same as "Trial ends" column above) + likelihood chip + one-line setup completion hint: "3 of 5 setup steps complete" |
| `past_due` | Amber left-border callout: last retry attempt timestamp + "Retry N of 4" + Stripe event link (`text-xs font-mono`, opens Stripe dashboard in new tab) + next scheduled retry. The link reads "View in Stripe" — not the raw event ID. |
| `unpaid` | Same as `past_due` callout but border is `border-red-500`. Add: "Invoice has been finalized but unpaid. Automatic retries have been exhausted." |
| `canceled` | Muted callout: cancellation date + cancellation reason if available from webhook payload. If `billing_archive` record exists, show lifetime revenue inline here. |
| `incomplete` | Muted amber callout: "Awaiting initial payment confirmation." |
| `incomplete_expired` | Muted callout: "Initial payment window expired. Subscription was never activated." |

The callout component is a `div` with a 2px left border, `px-3 py-2`, `text-sm`, `bg-muted/50`. This matches the existing bordered error block from Phase 1 in spirit but uses semantic border colors, not `border-destructive`, because these states are informational for the operator rather than errors in the UI.

**Plan change timeline:** Inline list of the last 3 entries from `subscription_plan_change_audit`, newest first. Each entry:
```
↑ starter → studio   · Mar 12, 2025  (upgrade)
↓ studio  → starter  · Jan 4, 2025   (downgrade)
  — (created on trial)  Oct 1, 2024
```
Arrow direction: `↑` `text-emerald-600` for upgrades, `↓` `text-red-500` for downgrades, `—` muted for initial creation. Use `ChevronUp` / `ChevronDown` Lucide icons for screen-reader compatibility (pair with `aria-label="upgrade"` / `aria-label="downgrade"`). If there are more than 3 entries, a `button` reading "View all N changes" expands the list via Radix `Collapsible`. No separate page needed in Phase 2.

**Lifetime value:** Single line at the bottom of the section: `Lifetime revenue: $X,XXX.00`. Source tooltip (same `Info` icon pattern): "Sum of `invoice.payment_succeeded` events from Stripe webhook history. For archived tenants, sourced from `billing_archive.total_revenue_usd`."

### Section F — Estimated Margin

Mirrors the Phase 1 "Estimated Cost Share" honesty pattern exactly.

**Section title:** "Estimated Margin" with the same `Info` icon `<button>`. Tooltip: "Monthly margin is revenue (plan price) minus estimated infra cost share. Revenue uses placeholder per-plan pricing from `lib/products/configs.ts`. Infra cost is the same proxy allocation shown in the Cost Share section above. This is an operational estimate, not accounting-grade P&L."

**Primary display:**

```
$XX.XX / mo             ↑ 42% margin
```

The big number is the margin dollar amount. The `↑ 42% margin` is the margin percentage, sitting on the same baseline as the big number, separated by a gap. No separate row.

Color rules for the big number (this is one of two places in the entire UI where the primary metric value changes color — the other being the Past Due tile count):
- Positive margin: `text-foreground` (default — no green coloring; green would imply "good" in a way that varies by business context)
- Negative margin (loss-making tenant): `text-red-600` — the number itself is red. This is the correct signal for an operator: this tenant costs more than they pay. No icon, no banner, just the red value.
- Margin of exactly zero: `text-muted-foreground`

A muted note beneath: "Loss-making" or "Break-even" or nothing (for positive margin) — plain text, no badge, no alert tone.

**3-up breakdown** (below the primary number):

```
Revenue       Infra cost (est.)    Margin
$XX.00        $XX.XX               $XX.XX
plan price    cost proxy           revenue − cost
```

Same `dl` grid pattern as Phase 1 cost breakdown. Labels use `text-xs text-muted-foreground uppercase tracking-wide`. Values use `tabular-nums`. The Margin value in the breakdown repeats the color rule above.

**"Estimated" in the heading** carries the honesty load — the primary value is NOT grayed out, same rationale as Phase 1.

---

## 3. Surface 3 — Mark8ly Overview Revenue Section (G1)

New `MetricsSection` inserted between Section A (Business KPIs) and Section B (Resources) on the product overview page. Revenue belongs above infrastructure — it is more strategically important at a glance.

### Updated section hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  PAGE HEADER  "Mark8ly"          [Time window ▼]  [Refresh]    │
├─────────────────────────────────────────────────────────────────┤
│  SECTION A — Business KPIs (existing)                           │
│  [Active tenants] [Stores] [Leads]                              │
├─────────────────────────────────────────────────────────────────┤
│  SECTION B — Revenue  ← NEW                                     │
│  [Total MRR] [ARR] [Churn rate] [New trials 30d]  — 4-up KPIs  │
│  [MRR 30d sparkline]                               — 1 sparkline│
├─────────────────────────────────────────────────────────────────┤
│  SECTION C — Resources (was B)                                  │
│  ... unchanged ...                                              │
├─────────────────────────────────────────────────────────────────┤
│  SECTION D — Cost (was C)                                       │
│  ... unchanged ...                                              │
├─────────────────────────────────────────────────────────────────┤
│  SECTION E — Email (was D)                                      │
│  ... unchanged ...                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Revenue KPI row (4-up)

| Tile | Value | Hint |
|---|---|---|
| Total MRR | `$X,XXX` | `active + trialing subs` |
| ARR | `$XX,XXX` | `MRR × 12` |
| Churn rate | `N.N%` | `last 30d` |
| New trials | `N` | `last 30d` |

ARR tooltip: "Extrapolated from current MRR × 12. Not an annualized contract value — it assumes today's subscriber mix holds for 12 months." Same `Info` icon trigger pattern. MRR tooltip mirrors the one on the Subscriptions list page summary tile.

Churn rate tooltip: "Subscriptions cancelled in the last 30 days divided by active subscriptions at the start of that period."

Churn rate coloring: `text-red-600` if > 10%, `text-amber-600` if 5–10%, `text-foreground` otherwise. The threshold is an operational heuristic for SaaS context — document it in the tooltip: "Highlighted amber above 5%, red above 10%."

### MRR sparkline

A single `SparklineCard` spanning full width below the 4-up KPI row (not in a 2-column grid — MRR trend warrants the full width). Label: "MRR trend — last 30 days". Current label: the same `$X,XXX` value as the KPI tile. Stroke color: the existing `text-foreground` / neutral palette — not a branded green, consistent with Phase 1's neutral chart color for resource metrics.

The X-axis on this chart departs from Phase 1's "hide all axes" rule: show a minimal 4-date X-axis (first, 10th, 20th, last day of the 30d window) because MRR trend — unlike CPU — has meaningful date context (end of month is when billing runs). Use `recharts` `XAxis` with `tick={{ fontSize: 10 }}` and `tickLine={false}` and `axisLine={false}`. Y-axis remains hidden; the tooltip covers precise values.

Accessibility `<figcaption>` describes: "MRR trend over the last 30 days. Current: $X,XXX. Direction: up/flat/down."

### Section gating

Like the Subscriptions page, the Revenue section is gated by `ProductConfig.features.subscriptions: boolean`. If false, the section does not render. The section ID is `section-revenue` for `aria-labelledby`.

---

## 4. Badge Taxonomy

### Status badge

Implemented as a `<Badge>` from `@tesserix/web` (the `variant` prop), or a lightweight `span` with the classes below if Badge does not support custom colors. Status is always shown as both color AND text — color is never the sole encoding (WCAG 1.4.1).

| Status | Token / class | Text | Icon |
|---|---|---|---|
| `active` | `bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400` | Active | None |
| `trialing` | `bg-blue-100 text-blue-800` | Trial | None |
| `past_due` | `bg-amber-100 text-amber-800` | Past due | `AlertTriangle h-3 w-3` inline |
| `unpaid` | `bg-red-100 text-red-800` | Unpaid | `AlertTriangle h-3 w-3` inline |
| `canceled` | `bg-neutral-100 text-neutral-500` | Canceled | None |
| `incomplete` | `bg-amber-50 text-amber-700` | Incomplete | None |
| `incomplete_expired` | `bg-neutral-100 text-neutral-400` | Expired | None |
| `paused` | `bg-neutral-100 text-neutral-600` | Paused | None |

For screen readers: `<span role="status" aria-label="Subscription status: Past due"><AlertTriangle aria-hidden="true" /> Past due</span>`. The `AlertTriangle` icon has `aria-hidden` — the text carries the meaning.

The amber/red distinction between `past_due` and `unpaid` is intentional and meaningful: `past_due` means retries are still in flight; `unpaid` means retries exhausted. These must not use the same color.

### Plan badge

`PlanBadge` is a new lightweight component alongside `StatusBadge`. Visual treatment: solid small pill, no outline. Hierarchy communicates tier.

| Plan | Treatment | Rationale |
|---|---|---|
| `trial` | `bg-neutral-100 text-neutral-500 border border-neutral-200` (outlined, muted) | Not paying; lowest visual weight |
| `starter` | `bg-neutral-800 text-neutral-100` (dark neutral) | Base paid tier |
| `studio` | `bg-neutral-800 text-neutral-100` (same base, slightly larger font-weight) | Mid tier — subtle differentiation |
| `pro` | `bg-neutral-900 text-white font-semibold` (near-black, bolder) | Premium tier |
| `marketplace` | `bg-neutral-900 text-white font-semibold ring-1 ring-neutral-600` (near-black + ring) | Top tier — ring adds distinction without color |

Rationale for monochrome tier system: avoids introducing new colors outside the token system. Weight and shade do the hierarchy work. `trial` is the visual outlier intentionally — it is the only muted/outlined badge, clearly distinguishing non-paying tenants from paying ones at a glance.

For screen readers: `<span aria-label="Plan: Pro">Pro</span>`. No `role` attribute needed — `span` is presentational; the `aria-label` gives full context.

---

## 5. Currency Display

**Phase 2 scope:** USD only. Display format: `$X,XXX.XX` — no currency symbol disambiguation needed.

**Tooltip deferred:** The "USD ≈ AUD ${rate}" tooltip is explicitly out of scope for Phase 2 because there is no rate source. Reserve the pattern for Phase 3 or when a rate API is available.

**Placeholder pricing:** All MRR/ARR/revenue values in Phase 2 are derived from `lib/products/configs.ts` placeholder prices. Every tooltip that mentions a revenue figure includes the note: "Uses placeholder per-plan pricing. Update `lib/products/configs.ts` with confirmed prices before relying on these figures for financial decisions." This honesty note replaces the Phase 1 cost-proxy note on revenue-derived tiles.

---

## 6. Information Architecture — New Page in Nav

The Subscriptions list page routes to `/admin/apps/mark8ly/subscriptions`. It sits in the Mark8ly sidebar rail between Tenants and Leads (billing health is more operationally critical than leads). Sidebar item label: "Subscriptions". No icon change needed — use `CreditCard` from Lucide.

The page is generated by a mark8ly-specific route file that passes the mark8ly `ProductConfig` to a generic `SubscriptionsListLayout` component, same pattern as `ProductOverviewLayout`. Future products with `features.subscriptions: true` get the page for free.

---

## 7. Accessibility Summary

- Sortable `<th>` elements use `<button>` child with `aria-sort` updated on click.
- Filter chip group: `role="group"` + `aria-label` + `aria-pressed` per chip + `aria-live="polite"` count announcement.
- Plan badges: `aria-label="Plan: {plan}"` on wrapping `span`.
- Status badges: `role="status"` + `aria-label="Subscription status: {status}"`.
- Plan change timeline icons: `aria-label="upgrade"` / `aria-label="downgrade"` on Lucide icons; icon `aria-hidden="true"` is insufficient alone when the icon is the only directional signal — the label is required.
- `Info` icon tooltips: `<button type="button" aria-label="[descriptive label]">` — same as Phase 1.
- Sparkline `<figure>` + `<figcaption class="sr-only">` — same as Phase 1.
- `prefers-reduced-motion`: `motion-safe:animate-spin` and `motion-safe:animate-pulse` — same as Phase 1.
- Color contrast: All badge text / background combinations above meet WCAG AA 4.5:1 on light backgrounds. Verify the amber combinations (`text-amber-800` on `bg-amber-100`) — they typically pass at 4.7:1 but confirm with a contrast checker during implementation.

---

## 8. Open Questions for Implementation

1. **Churn rate thresholds (5% / 10%)** — confirm with business context before shipping. These are placeholder SaaS benchmarks. The threshold values belong in `lib/products/configs.ts` as `churnRateThresholds: { amber: 0.05, red: 0.10 }` so they can be tuned without a code change.
2. **Trial conversion likelihood signal** — "High / Medium / Low" heuristic needs a concrete definition before implementation. Proposal: High = store has ≥ 1 product + ≥ 1 order; Medium = store has ≥ 1 product but no orders; Low = no products. Document the logic in `lib/products/mark8ly/trial-likelihood.ts`.
3. **Stripe dashboard link format** — confirm the Stripe dashboard URL pattern for webhook events (`https://dashboard.stripe.com/events/{event_id}`) and whether the operator's Stripe account requires a specific mode (test vs live) param to be appended.
4. **`billing_archive` population** — confirm whether `billing_archive` is populated for all deleted tenants or only tenants deleted after a certain date. If gaps exist, the lifetime revenue fallback to `sum(stripe_webhook_events.invoice.payment_succeeded)` must handle the case where neither source has data (show `—`, not `$0`).
5. **MRR time series source** — the 30-day MRR sparkline requires a daily MRR series. Confirm whether `stripe_webhook_events` has enough history to reconstruct this, or whether a materialized daily snapshot table is needed.
6. **`cancel_at_period_end` display** — if a subscription is `active` but `cancel_at_period_end: true`, the status badge should read "Active · Cancels Dec 1" rather than just "Active". This is a composite display state not covered by the badge taxonomy above; implement as an optional subtitle on the badge component.
