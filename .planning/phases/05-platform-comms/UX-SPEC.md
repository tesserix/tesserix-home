# UX Spec: Platform Tickets (Phase 5)

Surfaces: `/admin/platform-tickets` (list) and `/admin/platform-tickets/[id]` (detail).

Design direction: Linear/Vercel-style data-dense admin. `@tesserix/web` (shadcn/Radix) primitives throughout. WCAG 2.1 AA. Mirrors the density and layout conventions of the audit-logs page.

---

## 1. List Page — `/admin/platform-tickets`

### Page intent

Cross-product triage surface. An operator arriving here should answer "how many open tickets need attention, which are urgent, and where do they come from?" within one scan. This is not a search-first page — the operator is doing queue management, not lookup.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  PAGE HEADER  "Platform Tickets"              [Refresh]      │
├─────────────────────────────────────────────────────────────┤
│  SECTION A — Summary KPIs                                    │
│  [Open] [In Progress] [Avg Response (24h)] [Resolved / wk]  │
├─────────────────────────────────────────────────────────────┤
│  SECTION B — Filter bar                                      │
│  [Status chips] ·· [Product dropdown] ·· [Priority ▼]       │
├─────────────────────────────────────────────────────────────┤
│  SECTION C — Ticket table                                    │
│  # / Tenant + product chip / Subject / Status / Priority /  │
│  Submitter / Last activity / →                               │
└─────────────────────────────────────────────────────────────┘
```

Section headers use a hairline rule beneath, flush-left label, `text-xs text-muted-foreground uppercase tracking-wide` — same convention as the audit-logs layout.

### KPI tiles (Section A)

Four tiles in a `grid-cols-2 lg:grid-cols-4 gap-4` row, using the same `KpiTile` component pattern from Phase 1:

- **Open** — count of `status = open`. Tile is clickable; clicking it applies the Open filter chip.
- **In Progress** — count of `status = in_progress`. Same click-to-filter behaviour.
- **Avg Response** — median time from ticket creation to first platform_admin reply, over the last 24h window. Secondary text: "24h window". Shows "—" when there are no tickets with replies in the window.
- **Resolved this week** — count of tickets moved to `resolved` or `closed` in the current calendar week (Mon–Sun). Secondary text: "this week".

None of the tiles use delta pills — these are not growth metrics. The Open and In-Progress counts carry meaning through their raw value and the filter affordance.

### Filter bar (Section B)

Renders as a single `rounded-lg border border-border bg-card p-3 flex flex-wrap items-center gap-2` strip, consistent with the audit-logs filter bar.

**Status chips** — rendered as a segmented group of toggle buttons, not a dropdown. This is deliberate: the operator needs to jump between queues quickly without two clicks.

```
[ All ]  [ Open ]  [ In Progress ]  [ Resolved ]  [ Closed ]
```

Active chip: `bg-sidebar-accent text-sidebar-foreground`. Inactive: `text-muted-foreground hover:bg-muted/50`. One chip active at a time. "All" is the default.

Rationale: The audit-logs page uses Select dropdowns because severity has many values and is secondary. Status here is the primary navigation axis — five fixed options warrant chips.

**Product dropdown** — `Select` from `@tesserix/web`, default "All products". Options are dynamically populated from distinct `product_id` values present in the tickets table. As new products onboard, they appear automatically. Width `w-40 h-9 text-xs`.

**Priority dropdown** — `Select`, default "All priorities". Options: All / Urgent / High / Medium / Low. Width `w-36 h-9 text-xs`.

No free-text search on the list page — it is not needed for queue triage. A search/filter by subject or submitter email can be added in a follow-up phase if operators request it.

### Default sort

Open tickets first, then in_progress, then resolved, then closed. Within open/in_progress, urgent before high before medium before low. Within the same status+priority bucket, most-recently-filed first. This mirrors the priority logic already established in `AuditRow` — status precedence, then severity (priority) precedence.

Rationale: The operator's first job is to not miss an urgent open ticket. The sort order makes the most actionable item row 1 without requiring any filter interaction.

### Table columns

| Column | Notes |
|---|---|
| `#` | Ticket number, `font-mono text-xs text-muted-foreground`, e.g. `TKT-0042` |
| `Tenant` | Tenant name as primary text. Product chip directly below — `text-[10px] font-medium uppercase tracking-wide` pill, `bg-muted text-muted-foreground`, rounded-full. Mark8ly chip has a faint green tint (`bg-emerald-50 text-emerald-700` or equivalent muted tone). Future HomeChef chip gets a different muted hue chosen from the same low-saturation palette. |
| `Subject` | Truncated to one line with `truncate max-w-xs`. No tooltip needed — the subject is fully visible on the detail page. |
| `Status` | Status badge (see Section 5). |
| `Priority` | Priority badge (see Section 5). |
| `Submitter` | Email address, `text-xs text-muted-foreground`. |
| `Last activity` | Relative time ("3h ago"), `tabular-nums text-xs text-muted-foreground`. Tooltip on hover shows absolute timestamp. |
| `→` | `ChevronRight` icon, `text-muted-foreground`, not an interactive element itself — the whole row is a `<Link>` to the detail page. `aria-hidden="true"`. |

Rows: `border-b border-border last:border-0 hover:bg-muted/30`, same as `AuditRow`. The entire `<tr>` is not itself a link (inaccessible) — instead, the ticket number cell contains the primary `<Link>` and the row has an `onClick` handler that navigates programmatically, with `cursor-pointer`.

Accessibility note: the `<tr>` carries `aria-label="Ticket TKT-0042, open, urgent — the-bondi-store"` so screen readers can announce the row context before the user tabs into individual cells.

---

## 2. Detail Page — `/admin/platform-tickets/[id]`

### Layout choice: single-column stack with a sticky aside on wide viewports

On viewports >= 1280px, a two-column layout with a `w-72` right aside. On narrower viewports, the aside collapses below the thread. This mirrors the tenant detail page pattern already in the codebase.

```
┌──────────────────────────────────────┬─────────────────────┐
│  HEADER BLOCK                        │  ASIDE              │
│  TKT-0042 · "Checkout failing…"      │  Tenant: link       │
│  [open badge] [urgent badge]         │  Product: Mark8ly   │
│  Mark8ly chip · the-bondi-store ↗    │  ─────              │
├──────────────────────────────────────│  Submitted: date    │
│  IDENTITY STRIP                      │  Last reply: date   │
│  jane@bondi.co  ·  filed 2h ago      │  ─────              │
│  Last activity: 30m ago              │  → View tenant      │
├──────────────────────────────────────│  → Audit logs       │
│  DESCRIPTION                         │  (filtered)         │
│  prose block, whitespace preserved   │  → Billing health   │
├──────────────────────────────────────┴─────────────────────┤
│  REPLY THREAD                                               │
│  [reply cards, chronological]                               │
├─────────────────────────────────────────────────────────────┤
│  REPLY COMPOSER  (disabled when resolved/closed)           │
└─────────────────────────────────────────────────────────────┘
```

### Header block

Page title: `TKT-{number}` as a small `text-xs font-mono text-muted-foreground` prefix on the line above, then the subject as `text-xl font-semibold` below it. This is consistent with how the tenant detail page renders `"the-bondi-store"` as the h1. Status and priority badges render inline in a `flex items-center gap-2` row beneath the subject, alongside the product chip and a linked tenant name (→ opens tenant detail in the same tab).

No "Actions" dropdown on the header for Phase 5. Status changes happen in the composer area.

### Identity strip

A `dl` in a single row using `grid-cols-3 text-xs gap-x-6`, same pattern as the expanded `AuditRow` metadata block:

- Submitted by: email (plain text, not a link — submitter may not have a user record in tesserix-home)
- Filed: absolute timestamp, `tabular-nums`
- Last activity: absolute timestamp, `tabular-nums`

### Description block

`whitespace-pre-wrap text-sm leading-relaxed`. Contained in a `rounded-lg border border-border bg-card p-4`. No markdown rendering in Phase 5 — line breaks only. Label above: `text-xs text-muted-foreground uppercase tracking-wide` hairline rule beneath, "Original description".

### Reply thread

Chronological, oldest first, newest at the bottom (standard support-tool convention — the operator reads down to current state).

Each reply is a `<article>` card: `rounded-lg border border-border p-4 space-y-2`.

**Visual differentiation — merchant vs platform_admin:**

Do not use left/right alignment (chat-app convention, wrong for a work tool). Instead:

- **Merchant reply**: plain `bg-card border-border`. Author chip at top: small pill `bg-muted text-muted-foreground` showing the submitter email + "Merchant" label.
- **Platform Admin reply**: `bg-muted/40 border-border`. Author chip: `bg-sidebar-accent text-sidebar-foreground` with a "Platform" label. This is a subtle tonal shift — the same border weight, slightly different background — which makes the conversation scannable without being chat-y.

Author chip anatomy: `inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium`. Timestamp right-aligned in the same header row, `text-xs text-muted-foreground tabular-nums`.

Reply body: `text-sm whitespace-pre-wrap`.

Thread scroll area: no virtual scroll in Phase 5 — tickets should not have thousands of replies. If a ticket ever has >50 replies the page will still render acceptably; add pagination as a follow-up only if load time becomes measurable.

---

## 3. Reply Composer

Rendered as a `rounded-lg border border-border bg-card p-4` block at the bottom of the main column, below the thread.

Anatomy:

```
┌─────────────────────────────────────────────────────────────┐
│  [Textarea — "Reply to merchant…"]                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [Mark resolved on send ▼]              [Send reply →]      │
└─────────────────────────────────────────────────────────────┘
```

**Textarea**: `min-h-24`, auto-grows via `field-sizing: content` (or JS fallback). Placeholder: "Reply to merchant…". `aria-label="Reply to merchant"`. `aria-describedby` points to the hint text for the Cmd+Enter shortcut.

**Keyboard shortcut**: Cmd+Enter (macOS) / Ctrl+Enter (Windows/Linux) submits. A `text-[10px] text-muted-foreground` line below the textarea reads "Cmd+Return to send". This is read by the `aria-describedby` on the textarea so screen reader users get it on focus.

**Status-change-on-send control**: A `Select` (not a checkbox — it needs to accommodate three states). Options:

- "Just send" — sends the reply, status unchanged
- "Mark in progress on send" — transitions open → in_progress
- "Mark resolved on send" — transitions in_progress → resolved

Default value is "Just send". When the operator selects "Mark resolved on send", the `Select` trigger renders with a faint green tint (`text-emerald-700`) so the destructive-ish action is visually flagged before submit.

**Send button**: `Button variant="default"` — primary. Shows a `Loader2 animate-spin` icon while submitting. `aria-label="Send reply"`. Disabled while textarea is empty or while submitting.

**Loading state**: The Send button shows the spinner. The textarea and status Select remain enabled (do not disable them — if the request fails the operator should not lose their draft).

**Error state**: On failure, a `Sonner` toast fires: "Failed to send reply. Try again." The composer stays open with the draft intact. Do not clear the textarea on error.

**Success state**: On success, the new reply appears at the bottom of the thread (optimistic update or revalidation), the textarea clears, and the status Select resets to "Just send". A `Sonner` toast fires: "Reply sent." If the status was changed, the toast reads "Reply sent · Status updated to resolved."

**Focus management after send**: After a successful send, focus moves to the textarea again so the operator can continue composing if needed. Do not move focus to the new reply card — that would be disorienting.

---

## 4. Resolved / Closed State

When `status = resolved` or `status = closed`, the composer block is replaced by a banner:

```
┌─────────────────────────────────────────────────────────────┐
│  This ticket is resolved. Reopen it to send a reply.  [Reopen] │
└─────────────────────────────────────────────────────────────┘
```

Styling: `rounded-lg border border-border bg-muted/40 p-4 flex items-center justify-between text-sm text-muted-foreground`. The "Reopen" `Button variant="outline" size="sm"` transitions the ticket back to `open` immediately (no modal confirmation needed — reopening is low-stakes; the operator can re-resolve after).

Rationale for replacing rather than disabling the composer: a disabled textarea implies the system is broken. Replacing it with an explicit banner with a clear affordance (Reopen) correctly conveys intentional read-only state, consistent with Nielsen's heuristic of system status visibility.

The reply thread itself remains fully readable and scrollable regardless of status.

---

## 5. Priority Badge Taxonomy

Five-level scale rendered as `Badge` (shadcn/Radix) with `variant="outline"` as the base, colour applied via className override.

| Priority | Visual treatment | Rationale |
|---|---|---|
| `low` | `text-muted-foreground border-border` — near-invisible outline | Low tickets do not demand attention. Let them recede. |
| `medium` | `text-foreground border-border` — default outline, no colour | Legible but unremarkable. |
| `high` | `text-amber-700 border-amber-300 bg-amber-50` | Warm, visible, not alarming. |
| `urgent` | `text-rose-700 border-rose-300 bg-rose-50 font-semibold` | Clear signal. Font-weight bump reinforces urgency in dense rows. |

Color is never the sole encoding: the text label ("urgent", "high") is always present. Screen readers read the label directly.

Status badges follow the same logic:

| Status | Visual |
|---|---|
| `open` | `text-foreground border-border` — neutral, this is the default state |
| `in_progress` | `text-blue-700 border-blue-300 bg-blue-50` |
| `resolved` | `text-emerald-700 border-emerald-300 bg-emerald-50` |
| `closed` | `text-muted-foreground border-border bg-muted` — muted, terminal |

---

## 6. Cross-Product Visual Treatment

The product chip on each list row is the primary cross-product signal. Rules:

- The chip always has a `bg-{product}-50 text-{product}-700` pairing chosen per product from the low-saturation palette. Mark8ly: emerald. Future HomeChef: amber. Future FanZone: violet. These are registered in a `PRODUCT_CHIP_STYLES` config map, not hardcoded in the row component — the list component receives a `ProductConfig[]` array, same generalization pattern from Phase 1.
- The chip renders on two lines in the Tenant column (tenant name above, chip below), keeping the Subject column uncluttered.
- When the Product filter is set to a specific product, the chip still renders — the operator should not lose context when drilling into a single product queue.
- On the detail page, the product chip in the header is larger (`px-2.5 py-1 text-xs`) to make product identity immediately clear on a single-ticket view.

---

## 7. Empty, Loading, and Error States

### List page

**Empty state** (no tickets match filters): Replace the table body with a centered block:

```
  [LifeBuoy icon, h-8 w-8, text-muted-foreground]
  No platform tickets yet.
  text-sm text-muted-foreground
```

If filters are active (status or product filter applied), add a secondary line: "Try clearing the filters." — a `Button variant="link" size="sm"` that resets all filters.

**Loading state**: KPI tiles show `Skeleton` components matching the tile shape (`w-16 h-8` value, `w-24 h-3` label). Table body shows 5 skeleton rows — `Skeleton` bars filling each cell at the approximate column widths. Use `motion-safe:animate-pulse` to respect `prefers-reduced-motion`.

**Error state**: Same inline destructive block as audit-logs: `rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm` with the message "Could not load tickets." beneath the filter bar. Do not hide the KPI tiles section header; show "—" in each tile value and a muted `text-xs` note "Failed to load."

### Detail page

**Loading state**: Header area shows a `w-48 h-6` skeleton for the subject and two `w-20 h-5` skeletons for the badges. The description block shows a `w-full h-24` skeleton. The thread area shows 3 reply card skeletons.

**Error state**: Full-width `rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm` replacing the main content area: "Could not load this ticket." with a `Button variant="outline" size="sm"` labelled "Retry".

**Empty thread** (no replies yet): Inside the thread section, a muted note: `text-sm text-muted-foreground` — "No replies yet. Be the first to respond." Composer is still active.

---

## 8. Accessibility

### ARIA landmark structure

```
<main aria-label="Platform Tickets">
  <header> ... page heading + refresh control ... </header>
  <section aria-labelledby="section-summary">KPI tiles</section>
  <section aria-labelledby="section-tickets">
    <div role="toolbar" aria-label="Filter tickets">...chips + dropdowns...</div>
    <table aria-label="Platform tickets">...</table>
  </section>
</main>
```

Detail page:

```
<main aria-label="Ticket TKT-0042">
  <header> ... title + badges ... </header>
  <section aria-labelledby="section-description">...</section>
  <section aria-label="Reply thread" aria-live="polite" aria-relevant="additions">
    ... reply articles ...
  </section>
  <section aria-label="Reply composer">...</section>
</main>
```

### Reply thread keyboard navigation

Each reply `<article>` is not focusable by default — the thread is a reading surface, not an interactive one. Tab moves through the page sections naturally. If a future phase adds per-reply actions (quote, delete), those buttons will be inside each article and will receive focus normally.

The `<section>` for the reply thread has `aria-live="polite"` and `aria-relevant="additions"` so that when a new reply is appended, screen readers announce it without interrupting ongoing speech.

### Composer ARIA

- Textarea: `aria-label="Reply to merchant"`, `aria-describedby="composer-hint"`.
- Hint span (keyboard shortcut text): `id="composer-hint"`, `aria-hidden` is NOT set — screen readers should read it.
- Status Select: `aria-label="Status change on send"`.
- Send button: `aria-label="Send reply"`, `aria-disabled` when textarea empty (do not use the `disabled` attribute — it removes focus and prevents screen reader discovery).

### Focus management

- After sending: focus returns to textarea.
- After reopening a resolved ticket: focus moves to the textarea.
- On page load of the detail page: focus is on the `<h1>` (managed via `tabIndex={-1}` on the heading and `focus()` in a `useEffect`), consistent with the existing admin page pattern.

### Status chip buttons (list page)

The chip group uses `role="group"` with `aria-label="Filter by status"`. Each chip is a `<button>` with `aria-pressed` reflecting active state.

---

## 9. Mobile Behaviour

### List page (< 768px)

The table is not responsive-friendly at full column count. Strategy: hide low-priority columns on small viewports.

Hidden on mobile: Submitter, Last activity. Visible: ticket # + tenant/product chip (stacked), subject (truncated), status badge, priority badge, chevron. The table becomes a compact five-column layout at `text-xs`.

The filter strip stacks vertically: status chips wrap to two rows if needed (they are `flex-wrap`). Product and priority dropdowns go full-width (`w-full`).

KPI tiles collapse from `grid-cols-4` to `grid-cols-2`.

### Detail page (< 768px)

The right aside moves below the reply thread, rendered as a collapsible `<details>` / `<summary>` block labelled "Ticket details". Collapsed by default on mobile to keep the thread in focus. The summary line shows "Ticket details" with a `ChevronDown` icon.

The composer textarea goes full-width. The status-change Select and Send button stack vertically in a `flex-col gap-2` layout on screens < 480px.

The page title truncates to one line with `truncate` on mobile — the full subject is readable in the description block.

---

## 10. Sidebar Entry

Add to `platformNav` in `sidebar.tsx`, between "Apps" and "Settings":

```typescript
{ name: "Tickets", href: "/admin/platform-tickets", icon: LifeBuoy }
```

`LifeBuoy` from `lucide-react` (already available). This icon reads clearly as "support" without ambiguity; `MessageCircle` skews toward chat which is not the right mental model for a ticketing queue.

The nav item renders with an optional open-count badge. If `openCount > 0`, append a `<span>` inside the nav link: `inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 text-white text-[10px] font-semibold px-1 ml-auto`. The count is fetched by a lightweight server component or a shared SWR hook that polls the summary endpoint at a slow interval (every 5 minutes). The badge is `aria-label`'d: `aria-label="{openCount} open tickets"`.

On the left rail (icon-only), the `LifeBuoy` icon in the `RailIcon` component gets the same dot-badge treatment: a `2px × 2px` rose dot positioned `absolute top-1 right-1` on the icon container when `openCount > 0`. No count number at this scale — a presence indicator is sufficient.

---

## 11. Open Questions for Implementation

1. **Open-count polling cadence** — The sidebar badge needs a count endpoint. Confirm whether a dedicated `/api/admin/platform-tickets/summary` route is warranted or whether the list endpoint with `status=open&limit=0` (returning only `meta.total`) is sufficient.
2. **Avg response time calculation** — Defined above as median time to first platform_admin reply over 24h. If the `platform_ticket_replies` table is not indexed on `(ticket_id, author_type, created_at)`, this query will be slow. Add to the migration checklist.
3. **Reopen from closed** — The spec allows Reopen from both `resolved` and `closed`. Confirm whether `closed` is a terminal state that should not be reopened (e.g., spam, duplicate) — if so, the Reopen button should only show for `resolved`, and `closed` tickets should have a muted "Closed — read only" banner with no Reopen affordance.
4. **Submitter identity** — `submitted_by_email` is a string on the ticket. If the merchant admin user record is accessible via the tenant-service, the identity strip could link the email to the tenant's user list. Defer to Phase 5 implementation review.
5. **Billing health snippet in aside** — Defined as a "snippet" but the billing data source is not yet specified for this context. Implement as a placeholder KPI tile ("Billing — loading…") that can be wired in once the subscriptions API (Phase 2) is confirmed reachable from the tickets detail page.
