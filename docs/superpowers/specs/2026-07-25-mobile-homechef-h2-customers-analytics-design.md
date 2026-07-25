# Mobile HomeChef — Sub-slice H2: Customers & Analytics (design)

**Date:** 2026-07-25
**Area:** `apps/mobile` (Expo admin) — HomeChef product parity
**Decomposition:** HomeChef is split into 6 sub-slices (H1–H6). H1 (Trust & Moderation) shipped (`64dc55d`). This spec covers **H2 · Customers & Analytics**.

## Goal

Port the HomeChef customer + analytics surfaces into the mobile app: a light product **Overview** (platform-side KPIs), the **Analytics** KPI dashboard (hc gateway), the **Users** list (suspend/activate + wallet drill-down), and **Wallets** (balance, ledger, adjust). Most `hc`-gateway hooks already exist; the Overview adds a few `plat`-side hooks.

## Scope

Four screens plus hub wiring:

1. **Overview** — `apps/mobile/app/homechef/overview.tsx` (platform data via `plat`)
2. **Analytics** — `apps/mobile/app/homechef/analytics.tsx` (hc gateway)
3. **Users** — `apps/mobile/app/homechef/users.tsx` (hc gateway)
4. **Wallets** — `apps/mobile/app/homechef/wallets.tsx` (hc gateway)

Plus hub wiring in `app/homechef/index.tsx`: flip `Users`, `Wallets`, `Analytics` from `live:false` → `true`, and **add a new `Overview` hub row** (live:true) — mirror how the Mark8ly hub exposes its Overview (confirm exact placement/label against `app/mark8ly/index.tsx` during planning; default: an "Overview" row at the top of the Operations group).

Non-goals: cost breakdown, sparklines, time-window picker, and per-tenant metrics on the Overview (the Mark8ly Overview deliberately omits "sparklines/cost" — match that). No Users detail screen (web has none — list + inline actions only).

## Decisions (resolved during brainstorming)

- **Overview kept as a distinct screen** (user chose to include a light infra Overview), separate from Analytics. Overview = platform-side product KPIs via `plat`; Analytics = hc-gateway operational KPIs. Different data sources, deliberately both present (mirrors web, which has both pages).
- **Analytics doubles as the operational overview** — no separate hc-gateway "overview" screen; the single existing `Analytics` hub row is it.
- **Orders-by-status** renders as simple proportional horizontal bars (a small inline component), not a charting library — mobile has no chart lib wired, and the Mark8ly screens established KPI tiles + plain lists.
- **Wallets reached two ways:** a manual userId input (like web) and a deep-link from the Users list (`?userId=`). No dynamic route needed; read the optional `userId` query param.
- **Reason/confirm prompts reuse the H1 `PromptSheet`** (`components/prompt.tsx`, `useConfirm`) — e.g. user suspend/activate confirm.

## Screens

### 1. Overview (`overview.tsx`) — platform data via `plat`

Light scalar dashboard (no cost/sparklines/time-window), following `app/mark8ly/overview.tsx`'s pattern (`StatGrid` + `StatTile`, pull-to-refresh, partial-error `Banner`).

**Data (new `plat`-side hooks — add to `lib/platform-hooks.ts`):**
- `useHomechefKpis()` → `GET /apps/homechef/kpis` → `ProductKpis` (a `Record<string, number>` keyed by tile key: `chefs_active`, `orders_today`, `gmv_today`, `approvals_pending`). (`plat.get` prefixes `/api/admin`, so the path is `/apps/homechef/kpis`.)
- `useHomechefCritical()` → `GET /apps/homechef/audit-logs` with params `{ severity: 'critical', since_hours: 24 }` → `{ summary: { criticalLast24h: number } }`.
- `useHomechefMetrics()` → `GET /apps/homechef/metrics` with params `{ window: '24h' }` → `ProductMetrics` (only `resources.cpu.current` cores and `resources.memory.current` bytes are used here; ignore cost/email/etc.).

If a reusable product-scoped critical/metrics hook already exists (e.g. Mark8ly's `useCriticalCount` in `lib/mark8ly-hooks.ts`), prefer generalizing/reusing over duplicating — the extraction step determines whether it takes a product param or is Mark8ly-hardcoded.

**UI (tiles via `StatTile`/`StatGrid`, `SectionLabel` headers):**
- **Product KPIs** section: Active chefs (`chefs_active`), Orders today (`orders_today`), GMV today (`gmv_today`, ₹ via `formatINR`), Pending approvals (`approvals_pending`, `tone:'warning'` when > 0).
- **Health** section: Critical 24h (`criticalLast24h`, `tone:'danger'` when > 0), CPU (`resources.cpu.current` cores), Memory (`resources.memory.current` via `formatBytes`).
- Loading → `LoadingRows`; partial failure → `Banner tone="danger"` "Some data could not be loaded." (like Mark8ly overview). Pull-to-refresh refetches all three.

### 2. Analytics (`analytics.tsx`) — hc gateway

**Data (hooks EXIST in `lib/hooks.ts`):** `useStats()` → `AdminStats`; `useAnalytics()` → `AdminAnalytics`; `useActivities(limit)` → activities. **⚠ Extraction must confirm the `/activities` response shape** — the web analytics page reads it as a **bare `Activity[]`** ("returns a bare array, not the `{ data }` envelope"), but the mobile `useActivities` currently types it as `{ data: Activity[] }`. Fix the hook to the real shape before use.

**UI:**
- **Money & volume** `StatGrid`: Total revenue (`s.revenue`, ₹; show Δ from `s.revenueChange`, tone positive/critical), Revenue today (`s.revenueToday`), Total orders (`s.totalOrders`; Δ `s.ordersChange`), Orders today (`s.ordersToday`).
- **People & efficiency** `StatGrid`: Avg order value (`analytics.overview.avgOrderValue`, ₹), Total users (`s.totalUsers`; +`s.newUsersToday` today), Active users (`analytics.overview.activeUsers`), Chefs (`s.totalChefs`; sub `${s.pendingVerifications} pending` / "all verified", tone warning when pending).
- **Orders by status**: `Object.entries(analytics.ordersByStatus)` (a `Record<string, number>`) → sorted desc by count → a small proportional-bar list (label `titleCase(status)`, bar width ∝ count/max, count shown). Empty → "No order data yet."
- **Recent activity**: `useActivities(12)` → list rows (title, description, `formatRelative(timestamp)`). Empty → "No recent activity."
- `refetchInterval: 30_000` already on `useAnalytics`; add the same to `useStats`/`useActivities` calls here if not present (matches web's live-ish 30s refresh). Pull-to-refresh.

### 3. Users (`users.tsx`) — hc gateway

**Data:** `useUsers({ search, role, page, limit })` (EXISTS) → `Paginated<UserWithStats>`. Suspend/activate via `useAdminAction(['hc','users'])` → `PUT /users/:id/{suspend|activate}` (no body).

**UI:**
- `SearchField` (name/email) + role `FilterChips`: All (`''`), Customers (`customer`), Chefs (`chef`), Drivers (`delivery`), Admins (`admin`).
- Rows (`ListRow` or small card): title = `${firstName} ${lastName}`.trim() || `email`; subtitle = `email` · `titleCase(role)` · `${totalOrders} orders` · `formatINR(totalSpent)`; trailing active `Badge` (Active → success / Suspended → danger). Row actions: **Suspend/Activate** — `confirm` (destructive when suspending, message `${action} ${email}?`) → mutate; **Wallet** button → `router.push(('/homechef/wallets?userId=' + u.id) as never)`.
- `LoadingRows` / `EmptyState` ("No users found."). Pull-to-refresh.
- On mobile, present the two actions via an `Alert` action sheet (like `chefs.tsx`) or inline buttons — implementer picks the cleaner fit; the Suspend/Activate confirm goes through `useConfirm`.

### 4. Wallets (`wallets.tsx`) — hc gateway

**Data:** `useWallet(userId)` (EXISTS, `enabled: !!userId`) → `WalletResponse` (`balance`, `transactions: [{ id, source, reason, createdAt, type: 'credit'|'debit', amount }]`). Adjust via a mutation → `POST /wallet/:id/adjust` `{ amount, reason, type }`, invalidating `qk.wallet(userId)`.

**⚠ Extraction must confirm wallet amount units** — the web wallets page passes `balance`/`amount` straight through `formatINR` (i.e. **rupees**), unlike cancellations (paise ÷ 100). Mirror the web exactly; do NOT divide by 100 unless extraction shows paise.

**UI:**
- Read optional `userId` from `useLocalSearchParams`; seed a manual userId `TextInput` + "Load" button (sets the active id). Whichever provides the id drives `useWallet`.
- Before an id: hint "Enter a customer user ID, or open a wallet from the Users list."
- Balance card: `formatINR(balance)` (large).
- **Adjust** card: credit/debit toggle (two chips), amount `TextInput` (`keyboardType="decimal-pad"`, "Amount (₹)"), reason `TextInput` (required); "Apply" → validate (`amount > 0`, reason non-empty; inline error) → mutate. On success clear amount/reason and refetch.
- **Ledger** list: per txn — source (`titleCase`), reason, `formatDateTime(createdAt)`, and `± formatINR(amount)` with tone (credit → success/green, debit → danger/red). Empty → "No transactions."
- `LoadingRows` while `enabled && isLoading`; "No wallet found." when no data.

## Data-layer summary

**`lib/hooks.ts` (hc gateway):**
- Add a wallet-adjust mutation: `useAdjustWallet(userId)` → `POST /wallet/:id/adjust` `{ amount, reason, type }`, `onSuccess` invalidate `qk.wallet(userId)`.
- Fix `useActivities` to the real `/activities` shape (bare array vs `{ data }`) per extraction.
- Users suspend/activate reuses existing `useAdminAction`.

**`lib/platform-hooks.ts` (plat):**
- Add `useHomechefKpis`, `useHomechefCritical`, `useHomechefMetrics` (+ `pk` keys), or generalize existing product-scoped hooks. Add local types `ProductKpis`, the critical-summary shape, and the slice of `ProductMetrics` used (resources.cpu/memory) — confirm exact shapes via extraction (web types live in `apps/web/lib/metrics/product-metrics.ts` and `lib/admin/use-metrics.ts`).

**Exact wire shapes** (`AdminStats`, `AdminAnalytics`, `Activity`, `UserWithStats`, `WalletResponse`, `Paginated<T>`, `ProductKpis`, `ProductMetrics`) come from `@tesserix/homechef-shared` (hc) and the web metrics types (plat). A general-purpose agent extracts and confirms these — plus the three ⚠ flags (activities shape, wallet units, plat route reachability) — **before** the plan is written.

## Testing & gate

No RN unit-test runner. Gate = `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, clean. Multi-stage SDD review (per-task reviewer + whole-branch review). Device smoke = user's step.

## Execution

Established cycle: this spec → API-shape extraction agent → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (fresh implementer + task reviewer per task; whole-branch review). Commit directly to `main`, single-line messages, no signatures.

### Suggested task order (for the plan)
1. `lib/hooks.ts`: `useAdjustWallet` + `useActivities` shape fix.
2. `lib/platform-hooks.ts`: `useHomechefKpis` / `useHomechefCritical` / `useHomechefMetrics` (+ keys/types).
3. Users screen (list + suspend/activate + wallet link).
4. Wallets screen (load + balance + ledger + adjust).
5. Analytics screen (KPI tiles + orders-by-status bars + activity).
6. Overview screen (platform KPI/health tiles).
7. Hub wiring (flip 3 live + add Overview row) + full gate.
