# Mobile HomeChef — Sub-slice H4: Payments (design)

**Date:** 2026-07-25
**Area:** `apps/mobile` (Expo admin) — HomeChef product parity
**Decomposition:** HomeChef → 6 sub-slices. H1 (Trust) `64dc55d`, H2 (Customers & Analytics) `3c9a0a7`, H3 (Orders & Delivery) `a301a9d` shipped. This spec covers **H4 · Payments** — the heaviest, most money-sensitive slice.

## Goal

Port HomeChef's payments admin into mobile: weekly **Payouts** statements (+ mark-paid), **Payout Setup** (blocked chefs + automation toggle), **Payout Queue** (escrow release/withhold/reverse + bulk-release — the highest-stakes screen), **Refund Payouts** (execute meal-plan refunds), and a **read-only Payment Gateway** status view.

## Scope

Five screens + hub wiring:

1. **Payouts** — `apps/mobile/app/homechef/payouts.tsx` (**`plat`** — weekly settlement statements)
2. **Payout Setup** — `apps/mobile/app/homechef/payout-setup.tsx` (hc)
3. **Payout Queue** — `apps/mobile/app/homechef/payout-queue.tsx` (hc)
4. **Refund Payouts** — `apps/mobile/app/homechef/refund-payouts.tsx` (hc)
5. **Payment Gateway** — `apps/mobile/app/homechef/payment-gateway.tsx` (hc, **read-only**)

Plus hub wiring: add a new **"Payments" group** to `app/homechef/index.tsx` with these 5 rows (all `live:true`), and **remove the existing `Payouts` row from the "Money" group** (it moves into Payments). Wallets/Cancellations/Delivery-failures stay in Money.

## Decisions (resolved during brainstorming)

- **Payment Gateway is READ-ONLY on mobile** — show Razorpay + Stripe status (configured / test / LIVE, key prefix, webhook URL, secrets set/missing) but NO key-replacement form. Replacing live gateway credentials from a phone is too high-blast-radius; that stays desktop-only. (So `UpdateKeysResponse` / the PUT endpoints are not used.)
- **Payout Queue keeps bulk-release** ("Release all (N)" with a confirm), matching web.
- **CSV export (Payouts) is dropped** — awkward on mobile.
- **Payout Queue gets its own hub row** (it's central), rather than being link-only.
- **Refund Payouts uses the `hc` client** (the web page used a raw `fetch` to the same `/gw/...` path — mobile normalizes to `hc`).
- **All reason/confirm prompts reuse the H1 `PromptSheet`** (`components/prompt.tsx`, `useConfirm`). Money is **rupees** everywhere (no ÷100).

## Screens

### 1. Payouts (`payouts.tsx`) — plat

**Data (new plat hooks):** `useStatements({ status, page })` → `GET /apps/homechef/payouts?status&page` → `ListResponse` (local: `{ data: StatementRow[]; pagination: { page, limit, total, totalPages } }`). `useMarkPaid()` → `PUT /apps/homechef/payouts/:id/mark-paid` `{ payoutRef }`, invalidating the list. Local types `StatementRow`/`ListResponse` in `platform-contracts.ts` (extraction confirms field names — snake_case: `chef_id`, `chef_name`, `week_start/end`, `orders_count`, `gross_revenue`, `platform_commission`, `cgst/sgst/igst`, `tds`, `net_payout`, `status`, `paid_at`, `payout_ref`).

**UI:** status `FilterChips` (All/Pending/Paid) only — **the week-start date filter is dropped for v1** (a date picker is heavy on mobile; the endpoint returns recent statements without it). Pagination via a "Load more"/page control, or just the first page (limit 50) for v1 — the plan picks the simpler that keeps parity. List of statement cards (chef name, week window `formatDate(week_start) → formatDate(week_end)`, orders count, net payout `formatINR`, a small breakdown gross/commission/GST/TDS, status `Badge`, `payout_ref` if paid). Per pending row: **Mark paid** → `prompt` for the payout reference (required) → `useMarkPaid`; message notes it records a disbursement already made outside the app. `LoadingRows`/`EmptyState`, pull-to-refresh.

### 2. Payout Setup (`payout-setup.tsx`) — hc

**Data:** `useBlockedChefs()` → `GET /payouts/blocked-chefs` → `BlockedChefsResponse` (shared). Automation toggle → `PUT /chefs/:chefId/payout-automation` `{ value: PayoutAutomationValue }` (`'on'|'off'|''`), via a mutation invalidating blocked-chefs.

**UI:** per blocked chef (card): name, settlement-status `Badge` (`settlementTone`/`settlementLabel` helpers ported), a "What Razorpay needs" section rendering `parseSettlementRequirements(chef)` output (requirement text + resolution links → `Linking.openURL` if a link is present), and a 3-way automation control (On / Off / Default via a small segmented control or `FilterChips`-style). Turning **Off** ⇒ destructive `confirm` (it forces manual release via the queue). `LoadingRows`/`EmptyState` ("No blocked chefs."), pull-to-refresh.

### 3. Payout Queue (`payout-queue.tsx`) — hc, highest-stakes

**Data:** `usePendingPayouts(includeAwaiting)` → `GET /payouts/pending?include=awaiting` (only when toggled) → `PendingPayoutsResponse` (shared: eligible count + `PendingPayout[]`). Mutations (all `hc.post`, invalidating pending):
- `release(aggType, id)` → `POST /payouts/:aggType/:id/release`
- `withhold(aggType, id, reason)` → `POST /payouts/:aggType/:id/withhold` `{ reason }`
- `reverse(aggType, id, reason)` → `POST /payouts/:aggType/:id/reverse` `{ reason }`
- `bulkRelease(items)` → `POST /payouts/release-bulk` `{ items: [{ aggType, id }] }`

**UI:** header with eligible count + **Release all (N)** button (confirm) that batches all currently-eligible-without-open-issue rows; a two-state toggle (Eligible only / Include awaiting); per-hold cards (context label, type [Order/Group order/Tiffin day via `titleCase(aggType)`], net payout `formatINR` + gross, confirmed Yes/Auto, age badge — overdue >24h SLA styled danger via `ageLabel`, status `Badge` via `holdTone`), each with **Release** (confirm; destructive + warning when `hasOpenIssue`), **Withhold** (reason prompt), **Reverse** (reason prompt, destructive). Port helpers `holdTone`, `ageLabel`, `actionPath`, `SLA_HOURS=24`. `LoadingRows`/`EmptyState`, pull-to-refresh.

### 4. Refund Payouts (`refund-payouts.tsx`) — hc

**Data:** `usePendingRefunds()` → `hc GET /meal-plan-days/pending-refunds` → `{ data: PendingRefundDay[] }` (local `PendingRefundDay`: `dayId, date, slot, dishName, customerName, chefName, mealPlanNumber, chefChoice, refundAmount`). `useExecuteRefund()` → `hc POST /meal-plan-days/:dayId/execute-refund` (no body), invalidating.

**UI:** per pending-refund card: day/slot + date, plan/customer, chef·dish, chef decision `Badge` (full/half), refund amount `formatINR`; **Execute refund** button → `confirm` (money-sensitive: real Razorpay reversal, 5–7 days) → `useExecuteRefund`. Footer note (refund covers food + delivery, excludes GST + platform fee). `LoadingRows`/`EmptyState` ("No refunds pending."), pull-to-refresh.

### 5. Payment Gateway (`payment-gateway.tsx`) — hc, READ-ONLY

**Data:** `useGatewayStatus()` → `GET /payment-gateway/status` → `PaymentGatewayStatus` (shared); `useStripeStatus()` → `GET /payment-gateway/stripe/status` → `StripeGatewayStatus` (shared, extends with `publishableKeySet`).

**UI:** two `Card`s (Razorpay, Stripe). Each: a status `Badge` (Not configured / Test mode / **LIVE** — LIVE styled `warning`, matching web's intentional non-success), rows for key-secret / webhook-secret Set/Missing (`Badge`), key prefix + webhook URL (mono). **No forms, no mutations.** A short note that credentials are managed on desktop. `LoadingRows` while loading.

## Data-layer summary

**`lib/hooks.ts` (hc):** `qk` keys `blockedChefs`, `pendingPayouts`, `pendingRefunds`, `gatewayStatus`, `stripeStatus`. Hooks: `useBlockedChefs`, `useSetPayoutAutomation`, `usePendingPayouts(includeAwaiting)`, `useReleasePayout`/`useWithholdPayout`/`useReversePayout`/`useBulkReleasePayouts` (or a single parameterized payout-action mutation + bulk), `usePendingRefunds`, `useExecuteRefund`, `useGatewayStatus`, `useStripeStatus`. Local type `PendingRefundDay`.

**`lib/platform-contracts.ts` + `lib/platform-hooks.ts` (plat):** local `StatementRow`/`ListResponse`; `useStatements`, `useMarkPaid` (+ `pk` keys).

**Exact wire shapes** (shared: `BlockedChef`/`BlockedChefsResponse`/`PayoutAutomationValue`/`parseSettlementRequirements`, `PendingPayout`/`PendingPayoutsResponse`/`PayoutHoldStatus`, `PaymentGatewayStatus`/`StripeGatewayStatus`; local: `StatementRow`/`ListResponse`/`PendingRefundDay`) plus the exact plat payouts route paths/envelope and every hc endpoint above come from a general-purpose extraction agent — run **before** the plan is written, so tasks carry real types. Money is rupees throughout; verify no ÷100 anywhere (matches web).

## Testing & gate

No RN unit-test runner. Gate = `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, clean. Multi-stage SDD review — extra care on the money-sensitive mutations (Payout Queue, Refund, mark-paid). Device smoke = user's step.

## Execution

Established cycle: this spec → extraction agent → `superpowers:writing-plans` → `superpowers:subagent-driven-development`. Commit directly to `main`, single-line messages, no signatures. This slice is the largest (~8 tasks): 2 data-layer tasks (hc hooks; plat payouts hooks) + 5 screen tasks + hub wiring.

### Suggested task order (for the plan)
1. `lib/hooks.ts`: all hc payments hooks (blocked-chefs+toggle, pending-payouts+4 actions, pending-refunds+execute, gateway+stripe status) + local `PendingRefundDay`.
2. `lib/platform-contracts.ts` + `lib/platform-hooks.ts`: `StatementRow`/`ListResponse` + `useStatements`/`useMarkPaid`.
3. Payout Queue screen (build the highest-stakes one early for review focus).
4. Payout Setup screen.
5. Refund Payouts screen.
6. Payment Gateway screen (read-only).
7. Payouts screen (plat).
8. Hub wiring (new Payments group, 5 rows, move Payouts out of Money) + full gate.
