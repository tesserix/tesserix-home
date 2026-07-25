# Mobile HomeChef — Sub-slice H5: Marketing (design)

**Date:** 2026-07-25
**Area:** `apps/mobile` (Expo admin) — HomeChef product parity
**Decomposition:** HomeChef → 6 sub-slices. H1 `64dc55d`, H2 `3c9a0a7`, H3 `a301a9d`, H4 `0dcf351` shipped. This spec covers **H5 · Marketing** (full-parity authoring — the largest form-heavy slice).

## Goal

Port HomeChef's marketing admin to mobile at **full parity**: Campaigns (compose/preview/schedule/send/test/cancel/delete + metrics), Promos (create/edit/deactivate/reactivate discount codes + per-code analytics + search), and editable Winback + Loyalty config (+ analytics).

## Scope

Four screens + hub wiring:

1. **Campaigns** — `apps/mobile/app/homechef/campaigns.tsx` (hc; L — most stateful)
2. **Promos** — `apps/mobile/app/homechef/promos.tsx` (hc; L — most fields)
3. **Winback** — `apps/mobile/app/homechef/winback.tsx` (hc; S — editable config + analytics)
4. **Loyalty** — `apps/mobile/app/homechef/loyalty.tsx` (hc; S — editable config + analytics)

Plus hub wiring: add a new **"Marketing" group** to `app/homechef/index.tsx` with these 4 rows (all `live:true`). None currently exist as hub rows.

## Decisions (resolved during brainstorming)

- **Full parity, including authoring** (user's call): Campaigns and Promos ship their create/edit forms on mobile; Winback and Loyalty config is **editable** (not read-only). Money-config authoring on mobile is accepted.
- All money is **rupees** (raw numbers via `formatINR`, no ÷100 — matches web). Form numeric fields are held as strings, `Number()`-converted on submit (web pattern).
- Destructive/irreversible actions (campaign send/cancel/delete, promo deactivate) use the H1 `PromptSheet` (`useConfirm`). Config saves (winback/loyalty) are non-destructive — no confirm.
- Winback + Loyalty share the same shape (config card + analytics card) — build a shared internal pattern, two thin screens.

## Screens

### 1. Campaigns (`campaigns.tsx`) — hc, full lifecycle

**Reads:** `GET /campaigns?page&limit` → `{ data: Campaign[] }`; `GET /campaigns/:id/metrics` → `CampaignMetrics` (per sent campaign).
**Actions (all hc):** `POST /campaigns/preview {segment}` → `SegmentPreview` (audience size, used live in the form + before send); `POST /campaigns {CampaignInput}` (create draft); `PUT /campaigns/:id {CampaignInput}` (edit while draft/scheduled); `POST /campaigns/:id/schedule {scheduledAt}`; `POST /campaigns/:id/send` (irreversible mass-send — confirm shows preview counts); `POST /campaigns/:id/test` (send to admin only); `POST /campaigns/:id/cancel`; `DELETE /campaigns/:id` (draft/cancelled only).

**UI:** campaign list (status badges; per-item actions gated by status — `isEditable`/`isTerminal`); a **compose form** (`CampaignForm`) = segment builder (roles checkboxes customer/chef/delivery, recency select + days, subscription select, cities, new-within-days) + message composer (push title/body, email subject/HTML); a **schedule panel** (datetime picker); an inline **metrics** row for sent campaigns; a live **Preview** button (shows matched/reachable counts). Shared types: `Campaign`, `CampaignInput`, `CampaignMetrics`, `CampaignStatus`, `SegmentCriteria`, `SegmentPreview`, `parseSegment`, `formatDateTime`, `titleCase`.

Mobile authoring note: the segment builder + message composer become mobile form controls (checkbox rows, selects → a small segmented/picker control, text inputs incl. a multiline email-HTML field). Datetime-local → a mobile date/time entry (extraction/plan pick the lightest approach — likely a text field accepting ISO, or a minimal picker; keep it simple).

### 2. Promos (`promos.tsx`) — hc, full CRUD-ish

**Reads:** `GET /promos?search&page&limit` → `Paginated<Promo>`; `GET /chefs?page=1&limit=200` (lazy — only when funding source = chef) → `Paginated<ChefWithStats>`; `GET /promos/:id/analytics` → `PromoAnalytics`.
**Actions (hc):** `POST /promos {…13 fields…}` (create; blocks submit when `fundingSource==='chef'` && no `chefId`); `PUT /promos/:id {editable subset (+ optional patch e.g. {isActive:true} to reactivate)}` (edit/reactivate; code/fundingSource/chefId immutable); `DELETE /promos/:id` (soft deactivate — confirm, destructive, reversible).

**UI:** search field (debounced) + paginated list (code, discount, applies-to, funded-by, used, budget, expires, state, actions); a **create form** (collapsible, ~13 fields: code, description, discountType `PromoDiscountType`, discountValue, minOrderAmount, maxDiscount, usageLimit, perUserLimit, validUntil, fundingSource `PromoFundingSource`, applicableTo `'all'|'new_users'|'returning_users'`, chefId [conditional chef select], budgetCap); an expandable **detail** per row → analytics tiles (Redemptions, Total discount `formatINR`, Unique users, Budget left `formatINR`, Budget used %) + an inline **edit form** (editable subset) + a **Reactivate** button when inactive. Local types `PromoForm`/`EditForm` (string-held numeric fields) + `ApplicableTo` — re-declare from the web page verbatim. Shared: `Promo`, `PromoAnalytics`, `PromoDiscountType`, `PromoFundingSource`, `ChefWithStats`, `Paginated`, `formatINR`, `formatDateTime`.

### 3. Winback (`winback.tsx`) — hc, editable config + analytics

**Reads:** `GET /winback/config` → `WinbackConfig`; `GET /winback/analytics` → `WinbackAnalytics`.
**Action:** `PUT /winback/config {full WinbackConfig}` (enabled, discountPercent, maxDiscount ₹, validityDays, lapseThresholdDays, cooldownDays).
**UI:** a config card (enabled toggle + numeric fields, Save + saved/error state) and an analytics card (KPI tiles: Offers/Delivered/Reactivated/Expired/Reactivation rate + by-trigger breakdown via `WINBACK_TRIGGER_LABEL`, guarding the nil-slice `byTrigger`). Shared: `WinbackConfig`, `WinbackAnalytics`, `WINBACK_TRIGGER_LABEL`.

### 4. Loyalty (`loyalty.tsx`) — hc, editable config + analytics

**Reads:** `GET /loyalty/config` → `LoyaltyConfig`; `GET /loyalty/analytics` → `LoyaltyAnalytics`.
**Action:** `PUT /loyalty/config {full LoyaltyConfig}` (enabled, pointsPerRupee, redeemRate ₹/point, minRedeem, streakThreshold, streakBonus, streakGraceDays, tierSilverAt, tierGoldAt).
**UI:** config card (enabled toggle + 8 numeric fields + Save) + analytics card (KPI tiles: Members, Outstanding points [labeled a liability], Points earned, Points redeemed, Active streaks, Longest streak). Shared: `LoyaltyConfig`, `LoyaltyAnalytics`.

**Shared config pattern:** Winback + Loyalty are structurally identical (config card w/ enabled toggle + labeled numeric fields + Save; analytics card w/ tiles). Build a small reusable internal helper (a numeric-field config editor + a KPI-tiles block) to avoid duplicating both, or keep two focused screens sharing kit primitives — the plan decides.

## Data-layer summary

**`lib/hooks.ts` (hc):** new `qk` keys + hooks for campaigns (`useCampaigns`, `useCampaignMetrics(id)`, preview/create/edit/schedule/send/test/cancel/delete mutations), promos (`usePromos({search,page})`, `usePromoAnalytics(id)`, `useChefsForPromo` [reuse `useChefs`], create/edit/deactivate mutations), winback (`useWinbackConfig`, `useWinbackAnalytics`, `useSaveWinback`), loyalty (`useLoyaltyConfig`, `useLoyaltyAnalytics`, `useSaveLoyalty`). Local types `PromoForm`/`EditForm`/`ApplicableTo` (or in the screen). All hc gateway.

**Exact wire shapes** (`Campaign`/`CampaignInput`/`CampaignMetrics`/`CampaignStatus`/`SegmentCriteria`/`SegmentPreview`/`parseSegment`; `Promo`/`PromoAnalytics`/`PromoDiscountType`/`PromoFundingSource`; `WinbackConfig`/`WinbackAnalytics`/`WINBACK_TRIGGER_LABEL`; `LoyaltyConfig`/`LoyaltyAnalytics`) — a general-purpose extraction agent pulls these verbatim from `@tesserix/homechef-shared` **before** the plan, plus the local `PromoForm`/`EditForm` and the `CampaignForm`/segment-builder field details from the web pages. This is the critical pre-plan step given the form density.

## Testing & gate

No RN unit-test runner. Gate = `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, clean. Multi-stage SDD review — the campaigns send flow (irreversible) and promo chef-funding guard warrant extra care. Device smoke = user's step.

## Execution

Established cycle: this spec → **extraction agent** (essential here — the forms need exact `CampaignInput`/`SegmentCriteria`/`Promo` field lists) → `superpowers:writing-plans` → `superpowers:subagent-driven-development`. This is the largest slice (~9–11 tasks): data-layer (likely split across 2 tasks: campaigns hooks; promos+winback+loyalty hooks) + 4 screen tasks (campaigns and promos may each split into list-task + form-task) + hub wiring. Commit directly to `main`, single-line messages, no signatures.

### Suggested task order (for the plan)
1. hc hooks — campaigns (list/metrics/preview/create/edit/schedule/send/test/cancel/delete).
2. hc hooks — promos (list/analytics/create/edit/deactivate) + winback + loyalty (config/analytics/save); local `PromoForm`/`EditForm`.
3. Winback screen (editable config + analytics).
4. Loyalty screen (editable config + analytics).
5. Promos list + search + row-detail analytics + deactivate/reactivate.
6. Promos create/edit forms (the 13-field form + conditional chef select + funding guard).
7. Campaigns list + status actions (send/test/cancel/delete + metrics).
8. Campaigns compose form (segment builder + message composer) + schedule + preview.
9. Hub wiring (new Marketing group, 4 rows) + full gate.
