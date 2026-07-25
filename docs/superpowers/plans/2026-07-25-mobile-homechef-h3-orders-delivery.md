# Mobile HomeChef — Sub-slice H3: Orders & Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HomeChef mobile Order detail (behind a now-tappable Orders list), Meal Plans (read-only), Delivery (3PL) provider admin (`plat`), and a Delivery-intelligence cost dashboard (linked from Delivery) — and flip Meal plans + Delivery live in the hub.

**Architecture:** expo-router screens under `apps/mobile/app/homechef/`. Order detail + Delivery-intelligence use new `hc`-gateway hooks in `lib/hooks.ts`; Meal Plans uses the existing `useMealPlans`; Delivery (3PL) uses new `plat` hooks in `lib/platform-hooks.ts` (`plat.put` already exists). Reuses the H1 `useConfirm` primitive + kit/theme.

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, `@tesserix/homechef-shared`, kit in `apps/mobile/components/kit.tsx`, theme in `apps/mobile/lib/theme.ts`.

## Global Constraints

- **No RN unit-test runner.** Only gate is typecheck: `pnpm --filter @tesserix/homechef-shared build` (once) then `cd apps/mobile && npx tsc --noEmit` — clean. Every task ends with this gate + a commit. No unit tests; TDD does not apply.
- **Clients** (`apps/mobile/lib/api.ts`): `hc.get<T>(path, params?)` (prefix `/api/admin/apps/homechef/gw`); `plat.get<T>(path, params?)` / `plat.put<T>(path, body?)` (prefix `/api/admin`). All return `Promise<T>`. Errors → `apiError(e)`.
- **All order/delivery-reconciliation money is RUPEES** (`formatINR`). **Delivery-intelligence spend is USD** (a local `usd()` `$`-formatter); its zone pricing is rupees (`formatINR`).
- **`OrderDetailResponse`, `MealPlanRow`, `DeliveryIntelligenceResponse`, `OrderRow` are exported from `@tesserix/homechef-shared`.** `order.items` is `OrderDetailItem[] | null | undefined` (optional+nullable). `MealPlanRow.total` is a **required `number`** (no null check); `days?: MealPlanDayRow[]` (use `days?.length ?? 0`). `ProviderRow`/`Reconciliation` are **local snake_case** types (declare in `platform-contracts.ts`), NOT shared.
- **Delivery route envelopes:** `GET .../providers` → `{ data: ProviderRow[] }`; `GET .../reconciliation` → `{ data: Reconciliation }`; `PUT .../providers/:id/toggle` → `{ data: ProviderRow }` (read `.data` where needed).
- Forward-ref dynamic route pushes use `router.push('/homechef/orders/' + id as never)` (typedRoutes convention). Pushes to already-existing routes (`/homechef/cancellations`, `/homechef/support`, `/homechef/delivery-intelligence` once built) need no cast.
- Palette: no `danger` key — kit `Badge`/`Button` use `tone="danger"`; raw destructive color is `p.destructive`. Wire dates ISO strings.
- Match existing conventions (`orders.tsx`, `chefs.tsx`, `app/homechef/approvals/[id].tsx`, `app/mark8ly/overview.tsx`): kit components, theme tokens, `Screen`/`ScreenHeader`+back chevron or `BackButton`, `FilterChips`, `ListRow`, `Card`, `StatGrid`/`StatTile`, `Badge`, `Button`, `LoadingRows`, `EmptyState`.
- Commit messages: conventional, single-line, no signatures. Commit directly to `main`.

## Smoke-test harness (controller — user's step)

Metro 8082; dev build; sign-in user-driven. Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///homechef/delivery"`. Implementers gate on `tsc` only.

## File structure

- **Modify** `apps/mobile/lib/hooks.ts` — `useOrder`, `useDeliveryIntelligence` (+ keys). (Task 1)
- **Modify** `apps/mobile/lib/platform-contracts.ts` + `apps/mobile/lib/platform-hooks.ts` — `ProviderRow`/`Reconciliation` + 3 delivery hooks. (Task 2)
- **Move+modify** `apps/mobile/app/homechef/orders.tsx` → `apps/mobile/app/homechef/orders/index.tsx` (tappable rows); **Create** `apps/mobile/app/homechef/orders/[id].tsx`. (Task 3)
- **Create** `apps/mobile/app/homechef/meal-plans.tsx`. (Task 4)
- **Create** `apps/mobile/app/homechef/delivery-intelligence.tsx`. (Task 5)
- **Create** `apps/mobile/app/homechef/delivery.tsx`. (Task 6)
- **Modify** `apps/mobile/app/homechef/index.tsx` — flip Meal plans + Delivery live. (Task 7)

---

## Task 1: Data-layer — `useOrder` + `useDeliveryIntelligence`

**Files:** Modify `apps/mobile/lib/hooks.ts`

**Interfaces:** Produces `useOrder(id)` → `UseQueryResult<OrderDetailResponse>`; `useDeliveryIntelligence()` → `UseQueryResult<DeliveryIntelligenceResponse>`; `qk.order`, `qk.deliveryIntel` keys.

- [ ] **Step 1: Extend the shared type import**

In `apps/mobile/lib/hooks.ts`, add `OrderDetailResponse` and `DeliveryIntelligenceResponse` to the existing `@tesserix/homechef-shared` type import block:
```ts
  OrderDetailResponse,
  DeliveryIntelligenceResponse,
```

- [ ] **Step 2: Add keys + hooks**

Add to the `qk` object:
```ts
  order: (id: string) => ['hc', 'order', id] as const,
  deliveryIntel: ['hc', 'delivery-intel'] as const,
```
Append to end of file:
```ts
// ---- Order detail + delivery intelligence ----------------------------------
export const useOrder = (id: string) =>
  useQuery({
    queryKey: qk.order(id),
    queryFn: () => hc.get<OrderDetailResponse>(`/orders/${id}`),
    enabled: !!id,
  });

export const useDeliveryIntelligence = () =>
  useQuery({
    queryKey: qk.deliveryIntel,
    queryFn: () => hc.get<DeliveryIntelligenceResponse>('/delivery/intelligence'),
    refetchInterval: 30_000,
  });
```

- [ ] **Step 3: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): hooks useOrder + useDeliveryIntelligence"
```

---

## Task 2: Data-layer — delivery (3PL) plat hooks

**Files:** Modify `apps/mobile/lib/platform-contracts.ts`, `apps/mobile/lib/platform-hooks.ts`

**Interfaces:** Produces types `ProviderRow`, `Reconciliation`; hooks `useDeliveryProviders()` → `UseQueryResult<{ data: ProviderRow[] }>`, `useDeliveryReconciliation()` → `UseQueryResult<{ data: Reconciliation }>`, `useToggleDeliveryProvider()` → mutation over `id: string`; `pk.deliveryProviders`, `pk.deliveryReconciliation` keys.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- HomeChef delivery (3PL) — snake_case wire from the Go delivery admin ----
export interface ProviderRow {
  id: string;
  name: string;
  code: string;
  is_enabled: boolean;
  is_active: boolean;
  priority: number;
  base_cost: number;
  currency: string;
  total_deliveries: number;
  success_rate: number;
  last_used_at: string | null;
}
export interface Reconciliation {
  total_3pl_deliveries: number;
  provider_cost: number;
  collected_fee: number;
  margin: number;
}
```

- [ ] **Step 2: Add keys + hooks**

In `apps/mobile/lib/platform-hooks.ts`: add `ProviderRow`, `Reconciliation` to the `./platform-contracts` type import. Add to the `pk` object:
```ts
  deliveryProviders: ['plat', 'delivery-providers'] as const,
  deliveryReconciliation: ['plat', 'delivery-reconciliation'] as const,
```
Append the hooks (end of file):
```ts
// ---- HomeChef delivery (3PL) ------------------------------------------------
export const useDeliveryProviders = () =>
  useQuery({
    queryKey: pk.deliveryProviders,
    queryFn: () => plat.get<{ data: ProviderRow[] }>('/apps/homechef/delivery/providers'),
  });

export const useDeliveryReconciliation = () =>
  useQuery({
    queryKey: pk.deliveryReconciliation,
    queryFn: () => plat.get<{ data: Reconciliation }>('/apps/homechef/delivery/reconciliation'),
  });

export function useToggleDeliveryProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => plat.put(`/apps/homechef/delivery/providers/${id}/toggle`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk.deliveryProviders });
      qc.invalidateQueries({ queryKey: pk.deliveryReconciliation });
    },
  });
}
```

- [ ] **Step 3: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/lib/platform-contracts.ts apps/mobile/lib/platform-hooks.ts
git commit -m "feat(mobile): plat hooks for homechef delivery providers + reconciliation"
```

---

## Task 3: Orders list refactor + Order detail

**Files:** Move `apps/mobile/app/homechef/orders.tsx` → `apps/mobile/app/homechef/orders/index.tsx`; Create `apps/mobile/app/homechef/orders/[id].tsx`

**Interfaces:** Consumes `useOrders`, `useOrder` (`lib/hooks`); `formatINR`/`formatDateTime`/`titleCase`/`OrderDetailResponse` (shared); kit.

- [ ] **Step 1: Move the orders list into a folder**

```bash
git mv apps/mobile/app/homechef/orders.tsx apps/mobile/app/homechef/orders/index.tsx
```

- [ ] **Step 2: Update imports + make rows tappable**

Replace the full contents of `apps/mobile/app/homechef/orders/index.tsx` with (import paths go up THREE levels now, and the `ListRow` gets an `onPress`):
```tsx
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useOrders } from '../../../lib/hooks';
import { formatINR, titleCase } from '@tesserix/homechef-shared';
import { Badge, EmptyState, FilterChips, ListRow, LoadingRows, Screen, ScreenHeader, type Tone } from '../../../components/kit';
import { usePalette, space } from '../../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'delivering', label: 'Delivering' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;

function orderTone(status: string): Tone {
  if (status === 'delivered') return 'success';
  if (status === 'cancelled' || status === 'rejected') return 'danger';
  if (status === 'pending') return 'warning';
  return 'info';
}

export default function Orders() {
  const [status, setStatus] = useState('');
  const p = usePalette();
  const q = useOrders({ status: status || undefined, page: 1, limit: 30 });
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Orders"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No orders" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <ListRow
              title={`#${item.orderNumber}`}
              subtitle={`${item.customerName} → ${item.chefName} · ${item.itemCount} item${item.itemCount === 1 ? '' : 's'}`}
              meta={formatINR(item.total)}
              trailing={<Badge label={titleCase(item.status)} tone={orderTone(item.status)} />}
              onPress={() => router.push(('/homechef/orders/' + item.id) as never)}
            />
          )}
        />
      )}
    </Screen>
  );
}
```

- [ ] **Step 3: Create the Order detail screen**

Create `apps/mobile/app/homechef/orders/[id].tsx`:
```tsx
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useOrder } from '../../../lib/hooks';
import { formatINR, formatDateTime, titleCase } from '@tesserix/homechef-shared';
import { Badge, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, type Tone } from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

function statusTone(s: string): Tone {
  if (s === 'delivered') return 'success';
  if (s === 'cancelled' || s === 'rejected') return 'danger';
  if (s === 'pending') return 'warning';
  return 'info';
}
function paymentTone(s: string): Tone {
  if (s === 'completed') return 'success';
  if (s === 'refunded' || s === 'failed') return 'danger';
  return 'warning';
}

function Fact({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={{ minWidth: 120, flexGrow: 1, flexBasis: '40%' }}>
      <Text style={[text.caption, { color: p.mutedForeground }]}>{label}</Text>
      <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

export default function OrderDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useOrder(id);
  const back = (
    <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
      <ChevronLeft size={24} color={p.mutedForeground} />
    </Pressable>
  );

  if (q.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Order" right={back} />
        <LoadingRows />
      </Screen>
    );
  }
  if (!q.data) {
    return (
      <Screen>
        <ScreenHeader title="Order" right={back} />
        <Text style={[text.body, { color: p.mutedForeground, padding: space[4] }]}>Order not found.</Text>
      </Screen>
    );
  }

  const { order, customer, chef } = q.data;
  const items = order.items ?? [];
  const refunded = order.refundAmount > 0;

  return (
    <Screen>
      <ScreenHeader
        title={order.orderNumber}
        subtitle={`Placed ${formatDateTime(order.createdAt)} · ${titleCase(order.fulfillmentType)}`}
        right={back}
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Badge label={titleCase(order.status)} tone={statusTone(order.status)} />
          <Badge label={titleCase(order.paymentStatus)} tone={paymentTone(order.paymentStatus)} />
        </View>

        <View>
          <SectionLabel>Money</SectionLabel>
          <Card>
            <View style={styles.grid}>
              <Fact label="Subtotal" value={formatINR(order.subtotal)} />
              {order.serviceFee > 0 ? <Fact label="Service fee" value={formatINR(order.serviceFee)} /> : null}
              <Fact label="Delivery fee" value={formatINR(order.deliveryFee)} />
              <Fact label="Tax" value={formatINR(order.tax)} />
              {order.chefTip > 0 ? <Fact label="Chef tip" value={formatINR(order.chefTip)} /> : null}
              {order.driverTip > 0 ? <Fact label="Driver tip" value={formatINR(order.driverTip)} /> : null}
              {order.discount > 0 ? (
                <Fact label={order.promoCode ? `Discount (${order.promoCode})` : 'Discount'} value={`−${formatINR(order.discount)}`} />
              ) : null}
              {order.walletApplied > 0 ? <Fact label="Wallet applied" value={`−${formatINR(order.walletApplied)}`} /> : null}
              <Fact label="Total" value={formatINR(order.total)} />
              <Fact label="Paid via" value={titleCase(order.paymentProvider || '—')} />
              <Fact label="Refunded" value={refunded ? formatINR(order.refundAmount) : '—'} />
              {refunded ? <Fact label="Refund reason" value={order.refundReason || '—'} /> : null}
              {refunded ? <Fact label="Refund by" value={order.refundInitiatedBy ? titleCase(order.refundInitiatedBy) : '—'} /> : null}
            </View>
            {order.cancelledAt ? (
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12 }]}>
                Cancelled {formatDateTime(order.cancelledAt)}{order.cancelReason ? ` — ${order.cancelReason}` : ''}
              </Text>
            ) : null}
          </Card>
        </View>

        <View>
          <SectionLabel>Customer</SectionLabel>
          <Card>
            <View style={styles.grid}>
              <Fact label="Name" value={customer.name || '—'} />
              <Fact label="Email" value={customer.email || '—'} />
              <Fact label="Phone" value={customer.phone || '—'} />
              <Fact label="Joined" value={formatDateTime(customer.createdAt)} />
            </View>
          </Card>
        </View>

        <View>
          <SectionLabel>Chef</SectionLabel>
          <Card>
            <View style={styles.grid}>
              <Fact label="Kitchen" value={chef.businessName || '—'} />
              <Fact label="City" value={chef.city || '—'} />
            </View>
          </Card>
        </View>

        <View>
          <SectionLabel>Items</SectionLabel>
          <Card>
            {items.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No line items on this order.</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {items.map((it) => (
                  <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[text.body, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{it.name}</Text>
                    <Text style={[text.caption, { color: p.mutedForeground, fontVariant: ['tabular-nums'] }]}>
                      {formatINR(it.price)} × {it.quantity}
                    </Text>
                    <Text style={[text.body, { color: p.foreground, fontVariant: ['tabular-nums'], minWidth: 68, textAlign: 'right' }]}>
                      {formatINR(it.subtotal)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={{ flexGrow: 1, flexBasis: '45%' }}>
            <Button label="Cancellation arbitration" variant="secondary" onPress={() => router.push('/homechef/cancellations')} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '45%' }}>
            <Button label="Order issues" variant="secondary" onPress={() => router.push('/homechef/support')} />
          </View>
        </View>

        <Text style={[text.mono, { color: p.mutedForeground }]}>{order.id}</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({ grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 } });
```

- [ ] **Step 4: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/orders
git commit -m "feat(mobile): homechef order detail + tappable orders list"
```

---

## Task 4: Meal Plans screen

**Files:** Create `apps/mobile/app/homechef/meal-plans.tsx`

**Interfaces:** Consumes `useMealPlans` (`lib/hooks`); `formatDate`/`formatINR`/`titleCase`/`MealPlanRow` (shared); kit.

- [ ] **Step 1: Create the Meal Plans screen**

Create `apps/mobile/app/homechef/meal-plans.tsx`:
```tsx
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useMealPlans } from '../../lib/hooks';
import { formatDate, formatINR, titleCase, type MealPlanRow } from '@tesserix/homechef-shared';
import { Badge, EmptyState, FilterChips, ListRow, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;

function planTone(status: string): Tone {
  if (status === 'active') return 'success';
  if (status === 'cancelled') return 'danger';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

export default function MealPlans() {
  const p = usePalette();
  const [status, setStatus] = useState('');
  const q = useMealPlans({ status: status || undefined, page: 1, limit: 50 });
  const rows = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Meal plans"
        subtitle={q.data ? `${q.data.pagination.total} subscriptions · read-only` : 'Subscription oversight'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No meal plans" body="Nothing in this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }: { item: MealPlanRow }) => {
            const window = item.startDate
              ? `${formatDate(item.startDate)} → ${item.endDate ? formatDate(item.endDate) : 'ongoing'}`
              : '—';
            return (
              <ListRow
                title={item.id.slice(0, 8)}
                subtitle={`${window} · ${item.days?.length ?? 0} meals`}
                meta={formatINR(item.total)}
                trailing={<Badge label={titleCase(item.status)} tone={planTone(item.status)} />}
              />
            );
          }}
        />
      )}
    </Screen>
  );
}
```

- [ ] **Step 2: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/meal-plans.tsx
git commit -m "feat(mobile): homechef meal plans (read-only, status filter)"
```

---

## Task 5: Delivery-intelligence screen

**Files:** Create `apps/mobile/app/homechef/delivery-intelligence.tsx`

**Interfaces:** Consumes `useDeliveryIntelligence` (`lib/hooks`); `formatINR`/`formatCount`/`titleCase` (shared); kit (`StatGrid`/`StatTile`/`Card`/`Metric`/`SectionLabel`/`BackButton`/`Screen`/`ScreenHeader`/`LoadingRows`).

- [ ] **Step 1: Create the Delivery-intelligence screen**

Create `apps/mobile/app/homechef/delivery-intelligence.tsx`:
```tsx
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useDeliveryIntelligence } from '../../lib/hooks';
import { formatINR, formatCount, titleCase } from '@tesserix/homechef-shared';
import { BackButton, Card, LoadingRows, Metric, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

function usd(n: number | null | undefined): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}
function pct(ratio: number | null | undefined): string {
  const v = typeof ratio === 'number' && isFinite(ratio) ? ratio : 0;
  return `${(v * 100).toFixed(1)}%`;
}

export default function DeliveryIntelligence() {
  const p = usePalette();
  const q = useDeliveryIntelligence();
  const data = q.data;
  const u = data?.usage;

  return (
    <Screen>
      <ScreenHeader title="Delivery intelligence" subtitle="Pricing cost & usage · live" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : !data ? (
        <Text style={[text.body, { color: p.mutedForeground, padding: space[4] }]}>No delivery-intelligence data yet.</Text>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Requests (since restart)</SectionLabel></View>
          <StatGrid>
            <StatTile label="Cache hit ratio" value={pct(u?.distanceCacheHitRatio)} />
            <StatTile label="Paid routing" value={formatCount(u?.distanceProviderCalls)} />
            <StatTile label="Cache hits (free)" value={formatCount((u?.distanceHotHits ?? 0) + (u?.distanceDurableHits ?? 0))} />
            <StatTile label="Weather calls" value={formatCount(u?.weatherProviderCalls)} />
            <StatTile label="Fuel-index calls" value={formatCount(u?.fuelProviderCalls)} />
            <StatTile label="Traffic calls" value={formatCount(u?.trafficProviderCalls)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Expenses</SectionLabel></View>
          <StatGrid>
            <StatTile label="Spend since restart" value={usd(u?.estimatedSpendUsd)} />
            <StatTile label="All-time distance" value={usd(data.allTimeDistanceSpendUsd)} />
            <StatTile label="Routing $/call" value={usd(u?.distancePricePerCall)} />
            <StatTile label="Weather $/call" value={usd(u?.weatherPricePerCall)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Zone pricing by tier ({data.zoneTiers.length})</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4], gap: 8 }}>
            {data.zoneTiers.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No delivery zones configured yet.</Text>
            ) : (
              data.zoneTiers.map((t) => (
                <Card key={t.tier}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={[text.title, { color: p.foreground }]}>{titleCase(t.tier)}</Text>
                    <Text style={[text.caption, { color: p.mutedForeground }]}>{t.activeZoneCount}/{t.count} active</Text>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                    <Metric label="Base fare" value={formatINR(t.avgBaseFare)} />
                    <Metric label="Per km" value={formatINR(t.avgPerKmRate)} />
                    <Metric label="Minimum" value={formatINR(t.avgMinimumFare)} />
                    <Metric label="Surge" value={`${t.avgSurgeMultiplier.toFixed(2)}×`} />
                  </View>
                </Card>
              ))
            )}
          </View>

          <Text style={[text.caption, { color: p.mutedForeground, paddingHorizontal: space[4] }]}>
            Live counters reset on API restart. Auto-refreshes every 30s.
          </Text>
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 2: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/delivery-intelligence.tsx
git commit -m "feat(mobile): homechef delivery-intelligence cost dashboard"
```

---

## Task 6: Delivery (3PL) screen

**Files:** Create `apps/mobile/app/homechef/delivery.tsx`

**Interfaces:** Consumes `useDeliveryProviders`/`useDeliveryReconciliation`/`useToggleDeliveryProvider` (`lib/platform-hooks`), `ProviderRow` (`lib/platform-contracts`); `useConfirm` (`components/prompt`); `formatINR`/`formatCount`/`formatRelative` (shared); `apiError` (`lib/api`); kit.

- [ ] **Step 1: Create the Delivery screen**

Create `apps/mobile/app/homechef/delivery.tsx`:
```tsx
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useDeliveryProviders, useDeliveryReconciliation, useToggleDeliveryProvider } from '../../lib/platform-hooks';
import type { ProviderRow } from '../../lib/platform-contracts';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, formatCount, formatRelative } from '@tesserix/homechef-shared';
import {
  Badge, Button, Card, ListRow, LoadingRows, Screen, ScreenHeader, BackButton, SectionLabel, StatGrid, StatTile, StatusDot,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

export default function Delivery() {
  const p = usePalette();
  const providers = useDeliveryProviders();
  const recon = useDeliveryReconciliation();
  const toggle = useToggleDeliveryProvider();
  const { confirm } = useConfirm();
  const r = recon.data?.data;
  const rows = providers.data?.data ?? [];
  const refreshing = providers.isRefetching || recon.isRefetching;
  const refetchAll = () => { providers.refetch(); recon.refetch(); };

  async function onToggle(pr: ProviderRow) {
    const ok = await confirm({
      title: pr.is_enabled ? 'Disable provider' : 'Enable provider',
      message: `${pr.is_enabled ? 'Disable' : 'Enable'} ${pr.name} for new deliveries?`,
      confirmLabel: pr.is_enabled ? 'Disable' : 'Enable',
      tone: pr.is_enabled ? 'destructive' : 'default',
    });
    if (!ok) return;
    toggle.mutate(pr.id, { onError: (e) => Alert.alert('Toggle failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader title="Delivery (3PL)" subtitle="Providers & reconciliation" right={<BackButton onPress={() => router.back()} />} />
      {providers.isLoading || recon.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          <View style={{ paddingHorizontal: space[4] }}>
            <ListRow
              title="Cost intelligence"
              subtitle="Routing/weather spend, cache, zone pricing"
              trailing={<ChevronRight size={18} color={p.mutedForeground} />}
              onPress={() => router.push('/homechef/delivery-intelligence' as never)}
            />
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Reconciliation</SectionLabel></View>
          <StatGrid>
            <StatTile label="3PL deliveries" value={formatCount(r?.total_3pl_deliveries)} />
            <StatTile label="Provider cost" value={formatINR(r?.provider_cost)} />
            <StatTile label="Collected fees" value={formatINR(r?.collected_fee)} />
            <StatTile label="Margin" value={formatINR(r?.margin)} tone={r ? (r.margin < 0 ? 'danger' : 'success') : 'neutral'} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Providers</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4], gap: 8 }}>
            {rows.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No providers configured.</Text>
            ) : (
              rows.map((pr) => (
                <Card key={pr.id}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]}>{pr.name}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {pr.code} · priority {pr.priority} · {formatINR(pr.base_cost)} base
                      </Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {formatCount(pr.total_deliveries)} deliveries · {pr.success_rate.toFixed(1)}% · {pr.last_used_at ? formatRelative(pr.last_used_at) : 'never used'}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Badge label={pr.is_enabled ? 'Enabled' : 'Disabled'} tone={pr.is_enabled ? 'success' : 'neutral'} />
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <StatusDot tone={pr.is_active ? 'success' : 'neutral'} />
                        <Text style={[text.caption, { color: p.mutedForeground }]}>{pr.is_active ? 'active' : 'inactive'}</Text>
                      </View>
                    </View>
                  </View>
                  <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                    <Button
                      label={pr.is_enabled ? 'Disable' : 'Enable'}
                      variant="secondary"
                      tone={pr.is_enabled ? 'danger' : 'default'}
                      disabled={toggle.isPending}
                      onPress={() => onToggle(pr)}
                    />
                  </View>
                </Card>
              ))
            )}
          </View>

          <Text style={[text.caption, { color: p.mutedForeground, paddingHorizontal: space[4] }]}>
            Provider keys + connection test are managed in the Fe3dr API admin.
          </Text>
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 2: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/delivery.tsx
git commit -m "feat(mobile): homechef delivery 3PL (reconciliation + provider toggle)"
```

---

## Task 7: Hub wiring + final gate

**Files:** Modify `apps/mobile/app/homechef/index.tsx`

- [ ] **Step 1: Flip Meal plans + Delivery live**

In `apps/mobile/app/homechef/index.tsx`, flip `live: false` → `live: true` on exactly these two existing rows (leave all others unchanged — Payouts and Staff stay `false`):
- `Delivery` (Operations group): `{ title: 'Delivery', sub: '3PL providers + reconcile', icon: Truck, route: '/homechef/delivery', live: true },`
- `Meal plans` (Operations group): `{ title: 'Meal plans', sub: 'Tiffin subscriptions', icon: CalendarRange, route: '/homechef/meal-plans', live: true },`

(Delivery-intelligence intentionally has NO hub row — it is reached from the Delivery screen.)

- [ ] **Step 2: Full-slice gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean across the whole slice. Then:
```bash
git add apps/mobile/app/homechef/index.tsx
git commit -m "feat(mobile): homechef hub — Meal plans + Delivery live"
```

---

## Self-review (completed during authoring)

- **Spec coverage:** Order detail incl. money/customer/chef/items + money-seam links (T3), tappable orders list refactor (T3), Meal Plans read-only (T4), Delivery 3PL reconciliation + provider toggle + cost-intel link (T6), Delivery-intelligence dashboard (T5), data layer (T1 hc hooks, T2 plat hooks), hub wiring (T7). All spec screens covered; delivery-intelligence reached from Delivery per the brainstorming decision (no hub row).
- **Placeholder scan:** no TBD/TODO; every step carries full code or an exact edit.
- **Type consistency:** `useOrder(id)`→`OrderDetailResponse` consumed in T3 (`order.items ?? []`, all fields per extraction); `useDeliveryIntelligence()`→`DeliveryIntelligenceResponse` consumed in T5 (`data.usage`, `data.zoneTiers`); `useToggleDeliveryProvider().mutate(id)` matches T6; `useDeliveryProviders`/`useDeliveryReconciliation` return `{data}` envelopes, read via `.data` in T6; `ProviderRow` snake_case fields match T2 type; `MealPlanRow.total` used without null-check (required number); kit `Metric`/`StatusDot`/`StatGrid`/`StatTile` exist. `plat.put` exists (no api.ts change needed).
- **Routing:** orders folder refactor (`orders/index.tsx` + `orders/[id].tsx`), `git mv` preserves history; dynamic push cast `as never`; existing-route pushes (cancellations/support/delivery-intelligence) uncast (delivery-intelligence built in T5, before T6).
