# UX Spec: Resources + Cost Dashboards (Phase 1)

Surfaces: Mark8ly Overview (`/admin/apps/mark8ly`) and Tenant Detail (`/admin/apps/mark8ly/tenants/[id]`).

Design direction: Linear/Vercel-style data-dense admin. `@tesserix/web` (shadcn/Radix) primitives throughout. `recharts` for all charts. WCAG 2.1 AA.

---

## 1. Mark8ly Overview Page

### Page intent

Command center for a single product namespace. An operator arriving here should answer "is this product healthy right now, what is it costing, and how is it growing?" within 10 seconds without scrolling.

### Layout — section hierarchy and scan order

```
┌─────────────────────────────────────────────────────────────┐
│  PAGE HEADER  "Mark8ly"          [Time window ▼]  [Refresh] │
├─────────────────────────────────────────────────────────────┤
│  SECTION A — Business KPIs (existing 3-up, keep)           │
│  [Active tenants] [Stores] [Leads]                          │
├─────────────────────────────────────────────────────────────┤
│  SECTION B — Resources  (above the fold on 1280+ viewport)  │
│  [CPU %] [Memory %] [Pod count]  — 3-up KPI row             │
│  [CPU 24h area] [Memory 24h area]  — 2-up sparkline row     │
│  [DB size] [Repl lag] [Connections]  — 3-up KPI row         │
├─────────────────────────────────────────────────────────────┤
│  SECTION C — Cost  (one scroll)                             │
│  [MTD spend AUD]  [30d bar trend]  [Breakdown stack]        │
├─────────────────────────────────────────────────────────────┤
│  SECTION D — Email                                          │
│  [Sent] [Delivered] [Opened] [Bounced]  — 4-up KPI row      │
└─────────────────────────────────────────────────────────────┘
```

Section A (business KPIs) stays first — it is the answer to "is growth happening?". Infrastructure health (B) comes second because operators check it daily. Cost (C) is weekly. Email (D) is a secondary signal.

Section headers use a hairline rule beneath, flush-left text, no card borders wrapping the section itself — the visual grouping comes from spacing alone.

---

## 2. Tenant Detail Page

### Page intent

For a named tenant: who are they, are they using the product, what do they cost? Quick triage surface — the operator arrived from the Tenants list.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  PAGE HEADER  "the-bondi-store"  [Status badge]  [Actions]  │
├─────────────────────────────────────────────────────────────┤
│  SECTION A — Identity (existing)                            │
│  Owner email | Status | Created | Plan | Subdomain          │
├─────────────────────────────────────────────────────────────┤
│  SECTION B — Activity                                       │
│  [DB storage] [Orders] [Products] [Customers]  — 4-up row   │
│  [Request rate 24h sparkline]  [Bandwidth in/out sparkline] │
├─────────────────────────────────────────────────────────────┤
│  SECTION C — Email (last 30d)                               │
│  [Sent] [Delivered] [Opened] [Bounced]  — 4-up row          │
├─────────────────────────────────────────────────────────────┤
│  SECTION D — Cost proxy                                     │
│  [Estimated share AUD]  +  Attribution breakdown            │
└─────────────────────────────────────────────────────────────┘
```

Identity always leads — the operator needs to confirm they are looking at the right tenant. Activity and Email are peer sections with equal visual weight. Cost proxy is last because it is derived and less time-sensitive.

---

## 3. Component Patterns

### 3a. KPI Tile

Used wherever a single scalar metric needs to be communicated at a glance (business counts, resource levels, email stats, row counts).

Anatomy:
- Label: `text-xs text-muted-foreground uppercase tracking-wide`
- Value: `text-2xl font-semibold tabular-nums`
- Delta/hint (optional): colored delta pill (`+3 this week`) or plain secondary text (`of 120 total`)
- Trailing icon (optional): small Lucide icon, decorative, `aria-hidden`

Affordances:
- Tiles that link to a drill-down (tenants, leads) are `<Link>` wrappers with hover state. Tiles that show infra metrics are not clickable.
- `Tooltip` (Radix via `@tesserix/web`) on hover shows data source and last-refreshed timestamp: "Prometheus · refreshed 42s ago".

Composition: `@tesserix/web` `Card` with `CardHeader`/`CardContent`, or a bare `div` inside a CSS grid depending on whether a border is appropriate for the density level.

Accessibility: wrap the value in `<span aria-label="CPU usage 42 percent">42%</span>` for screen readers that would read "42 %" without context. Group related tiles in a `<section>` with `aria-labelledby` pointing to the section heading.

### 3b. Sparkline Card

Used for 24-hour trend lines (CPU, memory, request rate, bandwidth). Sits below its parent KPI row.

Anatomy:
- Small label top-left
- Current value top-right (same as the KPI tile above it, reinforcing context)
- `recharts` `AreaChart` filling the card body — no axes, no grid lines, no legend
- Tooltip on hover: timestamp + value, rendered via recharts `<Tooltip>` with `@tesserix/web` card styling via `content` prop override

Chart specifics:
- `AreaChart` with `fillOpacity={0.15}`, stroke color matching the semantic meaning (neutral/blue for resource metrics)
- X axis: hidden (`hide={true}`) — the 24h context is stated in the label
- Y axis: hidden — relative shape matters, not the exact scale. Exception: if the metric can spike to zero (replication lag) show a Y axis label of "0" at the baseline as a reference point
- Dot: hidden, only appears in the custom tooltip

Accessibility: wrap the recharts `<ResponsiveContainer>` in a `<figure>` with `<figcaption>` that describes the trend in words: "CPU usage over the last 24 hours. Current: 42%. Peak: 67% at 14:30." This is read by screen readers; the chart itself gets `aria-hidden="true"`.

### 3c. Cost Breakdown Stack

Used once per page for cost attribution.

Anatomy:
- Primary value: MTD spend in AUD, prominent
- Horizontal bar stack: each segment is a cost category (CPU, RAM, PV, network, LB) with a distinct muted color. No legend needed — labels appear inside or alongside the bar segments via `recharts` `<Cell>` + `<Tooltip>`.
- Below the bar: a small key–value list showing the AUD amount per category

Recharts implementation: `BarChart` with `layout="vertical"` and a single stacked bar, or a custom SVG bar using `recharts` `<ComposedChart>` — whichever produces cleaner output. Width 100%, fixed height ~40px for the bar itself.

Affordances: Hovering a segment shows a tooltip: "CPU — A$14.20 (38%)". No click-through in Phase 1.

### 3d. Time Window Picker

A single `Select` (from `@tesserix/web`) in the page header area controlling the time range for all metric sections on the page simultaneously. Default: "Last 24h". Options: "Last 1h", "Last 24h", "Last 7d", "Last 30d".

Important: the Email section always shows 30-day data (that is the SendGrid API's natural granularity). The time window picker should visually exclude the Email section — either a section-level note "Last 30 days (fixed)" or a distinct sub-header. Do not confuse the operator into thinking they can drill the email data to 1-hour resolution.

### 3e. Refresh Control

A borderless icon button (`Button variant="ghost" size="icon"`) in the page header, using `RefreshCw` from Lucide. While fetching: `animate-spin`. After a manual refresh, show a `Sonner` toast: "Mark8ly metrics refreshed". Auto-refresh interval: none by default in Phase 1 — polling adds complexity; operator can manually refresh.

Keyboard: `Button` is natively focusable. Add `aria-label="Refresh metrics"`.

---

## 4. Information Density vs Whitespace

The admin is used daily by 1–3 operators, not occasional visitors. Density bias is correct. Apply the following rules:

- Tile grids use `gap-4`, not `gap-6`. Padding inside tiles is `p-4`, not `p-6`.
- Section vertical spacing is `mt-8` between sections (generous) but `mt-4` within a section (tight). This gives rhythm without waste.
- Sparkline cards are shorter than KPI tiles — approximately `h-20` chart area. They are supplementary, not primary.

### Empty / no-data state

Show a muted placeholder text inside the tile where the value would be: "—" (an en-dash, not "N/A" or "Loading..."). If an entire section fails to load, replace the section body with an inline error variant consistent with the existing error treatment in `tenants/page.tsx` (bordered destructive block). Do not hide the section header — the operator needs to know the section exists but is unavailable.

### Loading state

Use `Skeleton` (`@tesserix/web`) matching the shape of the tile being loaded. KPI tiles: a `w-16 h-8` skeleton for the value, a `w-24 h-3` skeleton for the label. Sparkline cards: a `w-full h-20` skeleton for the chart area. Do not use full-page spinners.

### Stale/cached state

Append a muted inline timestamp to each section heading: "Resources · updated 5 min ago". If data is more than 15 minutes old, change the timestamp text color to `text-amber-600` and add a `Tooltip` on it: "Data may be stale. Click Refresh to update." No banner, no blocking UI.

---

## 5. Cost Honesty — Per-Tenant Proxy

The tenant-level cost is a derived allocation, not a measurement. The UI must be honest about this without being so hedged that the number becomes useless.

Recommended pattern:

**Section header:** "Estimated Cost Share" — the word "Estimated" is baked into the title. It is not a footnote.

**Primary value:** AUD amount, displayed normally (not grayed out).

**Attribution note:** directly beneath the primary value, in `text-xs text-muted-foreground`, a single line:
"Allocated from Mark8ly total · 50% requests, 30% storage, 20% egress"

**Info icon:** An `Info` icon (Lucide, `h-3.5 w-3.5`, `text-muted-foreground`) inline after the section heading. Its `Tooltip` (Radix) reads: "This is a proxy allocation, not a direct measurement. It divides the product's total GCP cost by each tenant's proportional share of requests, storage, and egress. Actual per-tenant infrastructure costs are not individually metered."

This combination — the word "Estimated" in the heading, the allocation basis inline, and the info tooltip for depth — is honest at every zoom level. An operator who reads only the heading knows the number is approximate. An operator who wants methodology can hover the info icon.

Do not use a gray/disabled color for the primary value itself — that would imply the number is unreliable, when it is a useful operational proxy. Reserve visual muting for the explanatory text only.

---

## 6. Generalization for Future Products

Both page templates must work for HomeChef, FanZone, and any future product namespace without code changes to the layout components. Identify the following as product-specific config rather than hardcoded UI:

| Element | Approach |
|---|---|
| Product name ("Mark8ly") | Passed as a prop or route param, never hardcoded in the component |
| Prometheus namespace label | Config per product (e.g., `mark8ly`, `homechef`) — drives all Prom queries |
| OpenCost namespace | Same config value |
| SendGrid `custom_args.product` filter | Config per product |
| Business KPI tiles (tenants, stores, leads) | Defined as a typed array in a per-product config object; layout component renders them generically |
| Row count entities (orders, products, customers on tenant detail) | Per-product array of `{ label, tableName }` passed to the activity section |
| Cost attribution basis (50/30/20 split) | Per-product constant; a future product may weight differently |

The layout components (`ProductOverviewLayout`, `TenantDetailLayout`) take a `ProductConfig` object as a prop. The mark8ly-specific pages pass the mark8ly config object; future product pages pass their own. No layout code knows about "mark8ly" by name.

---

## 7. Accessibility and Keyboard Navigation

### Focus management

- All interactive elements (tiles with drill-down links, refresh button, time picker, info icon tooltips) must be in the natural tab order.
- The time window `Select` is the first focusable element in the page content area (after the sidebar). Tab moves logically left-to-right, section by section.
- `Tooltip` triggers must be `<button>` elements (not `<div>` or `<span>`) so they receive focus. The `Info` icon tooltip uses `<button aria-label="Cost attribution methodology">`.

### Chart accessibility

- All `recharts` chart containers are wrapped in `<figure>` with `<figcaption>` (visually hidden via `sr-only`) providing a text description of the trend.
- The chart `<div>` itself gets `aria-hidden="true"` — the figcaption carries the accessible meaning.
- Do not use `role="img"` on recharts containers — it suppresses the chart's internal DOM from assistive technology but recharts does not produce meaningful internal ARIA anyway; `aria-hidden` plus `figcaption` is the correct pattern.
- Color is never the sole encoding for meaning in charts. The cost breakdown bar uses both color and text labels. Status badges in the tenant identity section use both color and text.

### ARIA landmark structure

```
<main aria-label="Mark8ly overview">
  <header> ... page heading + controls ... </header>
  <section aria-labelledby="section-business">...</section>
  <section aria-labelledby="section-resources">...</section>
  <section aria-labelledby="section-cost">...</section>
  <section aria-labelledby="section-email">...</section>
</main>
```

The sidebar uses `<nav aria-label="Mark8ly">` — already in place. Skip link at the top of the document (`#main-content`) per the existing WCAG baseline.

### Visible focus rings

All focusable elements inherit the existing `focus-visible:ring-2 focus-visible:ring-ring` pattern from `@tesserix/web`. Do not suppress focus rings. Sparkline cards that are not interactive do not receive focus.

### Reduced motion

The refresh spinner (`animate-spin`) and any loading skeleton animations must respect `prefers-reduced-motion`. Add `motion-safe:animate-spin` rather than bare `animate-spin`, and `motion-safe:animate-pulse` on skeleton components.

---

## 8. Open Questions for Implementation

1. **Prometheus auth from tesserix-home** — service account token or ingress with admin auth? Blocks K1 backend work. (Noted in BACKLOG.md open decisions.)
2. **SendGrid Activity API tier** — confirm the account has Activity API access before building K4. The UI can stub to "—" gracefully but the API route needs verification.
3. **Cost attribution basis for L2** — spec uses 50/30/20 (requests/storage/egress) as stated in the backlog. If a different basis is chosen, the tooltip text and `ProductConfig` constant change; no layout work required.
4. **Auto-refresh interval** — Phase 1 ships with manual refresh only. If operators want auto-refresh, a 60-second interval is the minimum that avoids hammering Prometheus; add as a follow-up toggle.
