# Mobile HomeChef — Sub-slice H3: Orders & Delivery (design)

**Date:** 2026-07-25
**Area:** `apps/mobile` (Expo admin) — HomeChef product parity
**Decomposition:** HomeChef → 6 sub-slices. H1 (Trust) shipped `64dc55d`; H2 (Customers & Analytics) shipped `3c9a0a7`. This spec covers **H3 · Orders & Delivery**.

## Goal

Port HomeChef's order + delivery surfaces into the mobile app: a read-only **Order detail** (behind the existing Orders list), the read-only **Meal Plans** list, the `plat`-side **Delivery (3PL)** admin (reconciliation + provider enable/disable), and the read-only **Delivery-intelligence** cost dashboard (linked from Delivery).

## Scope

Four screens + an orders list refactor + hub wiring:

1. **Order detail** — `apps/mobile/app/homechef/orders/[id].tsx` (hc gateway). Requires converting the existing flat `apps/mobile/app/homechef/orders.tsx` → `apps/mobile/app/homechef/orders/index.tsx` and making its rows tappable.
2. **Meal Plans** — `apps/mobile/app/homechef/meal-plans.tsx` (hc gateway; `useMealPlans` already exists).
3. **Delivery (3PL)** — `apps/mobile/app/homechef/delivery.tsx` (**`plat`**, not hc).
4. **Delivery-intelligence** — `apps/mobile/app/homechef/delivery-intelligence.tsx` (hc gateway), reached via a link on the Delivery screen (no hub row).

Plus hub wiring in `app/homechef/index.tsx`: flip `Meal plans` and `Delivery` from `live:false` → `true`.

Non-goals: any order/delivery mutations beyond the provider enable/disable toggle (order detail is read-only by design — refunds live in Cancellations/Order-issues, which enforce caps/idempotency server-side); provider key config + connection test (web says those live in the Fe3dr API admin, not here); zone-pricing edits (Go-side).

## Decisions (resolved during brainstorming)

- **Delivery-intelligence is reached via a link on the Delivery screen** (a "Cost intelligence →" affordance at the top), not a hub row — it's a niche cost sub-view of delivery and has no web nav entry.
- **Order detail drops the web's search-seeded "View customer"/"View kitchen" deep-links** (the mobile users/chefs screens don't read a search param). Customer/chef info still shows inline. The two money-seam links are **kept**: Cancellation arbitration → `/homechef/cancellations`, Order issues → `/homechef/support`.
- **Orders list becomes a folder** (`orders/index.tsx` + `orders/[id].tsx`), mirroring the approvals convention. The `/homechef/orders` route still resolves to `orders/index.tsx`.

## Screens

### 1. Order detail (`orders/[id].tsx`) — hc gateway, read-only

**Data (new hook):** `useOrder(id)` → `hc GET /orders/:id` → `OrderDetailResponse` `{ order, customer, chef }`. Add `qk.order = (id) => ['hc','order',id]`, `enabled: !!id`.

Web fields used (confirm via extraction): `order`: `orderNumber`, `status`, `paymentStatus`, `createdAt`, `fulfillmentType`, `subtotal`, `serviceFee`, `deliveryFee`, `tax`, `chefTip`, `driverTip`, `discount`, `promoCode`, `walletApplied`, `total`, `paymentProvider`, `refundAmount`, `refundReason`, `refundInitiatedBy`, `cancelledAt`, `cancelReason`, `items[]{ id, name, price, quantity, subtotal }`, `id`. `customer`: `{ name, email, phone, createdAt }`. `chef`: `{ businessName, city }`. All money is **rupees** (pass through `formatINR`).

**UI** (ScrollView, `BackButton`): header — `orderNumber` + status `Badge` (`statusTone`: delivered→success, cancelled/rejected→danger, pending→warning, else info) + payment `Badge` (`paymentTone`: completed→success, refunded/failed→danger, else warning); "Placed {formatDateTime(createdAt)} · {titleCase(fulfillmentType)}". **Money** card: a label/value grid (subtotal; service fee if >0; delivery fee; tax; chef tip if >0; driver tip if >0; discount if >0 with promoCode; wallet applied if >0; total; paid via; refunded amount + reason + by when `refundAmount>0`); a cancelled line when `cancelledAt`. **Customer** card (name/email/phone/joined). **Chef** card (kitchen/city). **Items** card: line-item rows (name, price, qty, subtotal) or "No line items." Two link buttons: Cancellation arbitration, Order issues. Monospace `order.id` footer.

**Orders list refactor** (`orders/index.tsx`): move the current `orders.tsx` verbatim, then add `onPress={() => router.push('/homechef/orders/' + item.id as never)}` to the `ListRow`. (`OrderRow` has `id` — confirm.)

### 2. Meal Plans (`meal-plans.tsx`) — hc gateway, read-only

**Data:** `useMealPlans({ status, page, limit })` (exists) → `Paginated<MealPlanRow>`. `MealPlanRow`: `id`, `startDate`, `endDate`, `days[]`, `total`, `status` (confirm via extraction).

**UI:** `FilterChips` (All=''/Active/Paused/Cancelled); rows (`ListRow` or card): title = `id.slice(0,8)`; subtitle = window `${formatDate(startDate)} → ${endDate ? formatDate(endDate) : 'ongoing'}` (or "—"), `${days?.length ?? 0} meals`, total `formatINR(total)` when non-null; trailing status `Badge` (`tone`: active→success, cancelled→danger, paused→warning, else neutral). `LoadingRows` / `EmptyState` ("No meal plans."). Pull-to-refresh. Subtitle notes "read-only".

### 3. Delivery (3PL) (`delivery.tsx`) — plat, with a toggle mutation

**Data (new plat hooks in `lib/platform-hooks.ts`):**
- `useDeliveryProviders()` → `plat GET /apps/homechef/delivery/providers` → `{ data: ProviderRow[] }` (read `.data`).
- `useDeliveryReconciliation()` → `plat GET /apps/homechef/delivery/reconciliation` → `{ data: Reconciliation }`.
- `useToggleDeliveryProvider()` → `plat PUT /apps/homechef/delivery/providers/:id/toggle` (no body), invalidating both keys.

`ProviderRow` and `Reconciliation` are declared **locally** in the web page (not in `@tesserix/homechef-shared`) — declare them locally in mobile too (in `platform-contracts.ts`): `ProviderRow { id, name, code, is_enabled, is_active, priority, base_cost, currency, total_deliveries, success_rate, last_used_at: string | null }`; `Reconciliation { total_3pl_deliveries, provider_cost, collected_fee, margin }`.

**⚠ Extraction must confirm** the `plat` client has a `put` method (the toggle is a PUT). The earlier H2 extraction listed `plat.get/post/patch` — if there is no `plat.put`, **add one to `apps/mobile/lib/api.ts`** (mirroring `plat.post`, no body) as the first plan task. Also confirm the Next.js routes `/api/admin/apps/homechef/delivery/{providers,reconciliation,providers/[id]/toggle}` exist and `plat` reaches them.

**UI** (ScrollView, `BackButton`): a **"Cost intelligence →"** link near the top → `router.push('/homechef/delivery-intelligence')`. Reconciliation `StatGrid`: 3PL deliveries (`formatCount`), Provider cost (`formatINR`, hint "what Fe3dr pays 3PLs"), Collected fees (`formatINR`, hint "from customers"), Margin (`formatINR`, tone success/danger by sign, hint surplus/subsidy). Provider list (cards): name + `code` (mono), priority, base cost (`formatINR`), deliveries (`formatCount`), success `${success_rate.toFixed(1)}%`, enabled/disabled `Badge`, active dot, last used (`formatRelative` or "—"), and an **Enable/Disable** button → `confirm` (destructive when disabling, `${name}`) via the H1 `useConfirm`, then toggle. `LoadingRows` / `EmptyState` ("No providers configured."). Note "Provider keys + connection test are managed in the Fe3dr API admin." Pull-to-refresh.

### 4. Delivery-intelligence (`delivery-intelligence.tsx`) — hc gateway, read-only

**Data (new hook):** `useDeliveryIntelligence()` → `hc GET /delivery/intelligence` → `DeliveryIntelligenceResponse`, `refetchInterval: 30_000`. Shape (confirm via extraction): `usage { distanceProviderCalls, distanceHotHits, distanceDurableHits, distanceCacheHitRatio, weatherProviderCalls, fuelProviderCalls, trafficProviderCalls, estimatedSpendUsd, distancePricePerCall, weatherPricePerCall }`, `allTimeDistanceSpendUsd`, `cachedTrips`, `zoneTiers[] { tier, count, activeZoneCount, avgBaseFare, avgPerKmRate, avgMinimumFare, avgSurgeMultiplier }`.

**UI** (ScrollView, `BackButton`): local `usd(n)` helper (`$` + `toFixed(n<1?4:2)` — sub-cent precision) and `pct(ratio)` (`(ratio*100).toFixed(1)%`). **Requests** section (`StatTile`s): Cache hit ratio (`pct`, hint "{lookups} distance lookups" where lookups = provider+hot+durable), Paid routing calls, Cache hits (free) (hot+durable, hint "{hot} Redis · {durable} CNPG"), Weather calls, Fuel-index calls, Traffic calls. **Expenses** section: Spend since restart (`usd(estimatedSpendUsd)`), All-time distance spend (`usd(allTimeDistanceSpendUsd)`, hint "{cachedTrips} trips paid once"), Routing price/call (`usd`), Weather price/call (`usd`). **Zone pricing by tier** ({zoneTiers.length}): per-tier cards/rows — `titleCase(tier)`, zones `count`, active `activeZoneCount`, avg base fare / per-km / minimum (`formatINR`), avg surge `${avgSurgeMultiplier.toFixed(2)}×`; empty → "No delivery zones configured yet." Footer note about counters resetting on restart + 30s refresh.

## Data-layer summary

**`lib/hooks.ts` (hc):** add `qk.order`, `qk.deliveryIntel` keys; `useOrder(id)`; `useDeliveryIntelligence()`; local type `OrderDetailResponse`/`DeliveryIntelligenceResponse` come from `@tesserix/homechef-shared` if exported (confirm) — otherwise declare locally.

**`lib/platform-contracts.ts` + `lib/platform-hooks.ts` (plat):** `ProviderRow`, `Reconciliation` types; `useDeliveryProviders`, `useDeliveryReconciliation`, `useToggleDeliveryProvider` (+ `pk` keys). Possibly a new `plat.put` in `lib/api.ts`.

**Exact wire shapes** (`OrderDetailResponse`, `MealPlanRow`, `DeliveryIntelligenceResponse`, `OrderRow.id`) come from `@tesserix/homechef-shared`; `ProviderRow`/`Reconciliation` are local (from the web delivery page). A general-purpose agent extracts and confirms these — plus the ⚠ flags (`plat.put` existence, delivery route reachability, whether `OrderDetailResponse`/`DeliveryIntelligenceResponse` are shared exports) — **before** the plan is written.

## Testing & gate

No RN unit-test runner. Gate = `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, clean. Multi-stage SDD review. Device smoke = user's step.

## Execution

Established cycle: this spec → extraction agent → `superpowers:writing-plans` → `superpowers:subagent-driven-development`. Commit directly to `main`, single-line messages, no signatures.

### Suggested task order (for the plan)
1. `lib/hooks.ts`: `useOrder` + `useDeliveryIntelligence` (+ keys/types); and (if needed) `plat.put` in `lib/api.ts`.
2. `lib/platform-contracts.ts` + `lib/platform-hooks.ts`: `ProviderRow`/`Reconciliation` + 3 delivery hooks.
3. Orders list refactor (`orders.tsx` → `orders/index.tsx`, tappable rows) + Order detail (`orders/[id].tsx`).
4. Meal Plans screen.
5. Delivery-intelligence screen.
6. Delivery (3PL) screen (links to delivery-intelligence).
7. Hub wiring (flip Meal plans + Delivery live) + full gate.
