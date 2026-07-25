# Mobile HomeChef — Sub-slice H2: Customers & Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four HomeChef mobile screens — Overview (platform KPIs + resources), Analytics (hc KPI dashboard + orders-by-status bars + activity), Users (list + suspend/activate + wallet drill-down), Wallets (balance/ledger/adjust) — and flip them live in the hub.

**Architecture:** expo-router screens under `apps/mobile/app/homechef/`. Overview uses two NEW product-scoped `plat` hooks in `lib/platform-hooks.ts`; Analytics/Users/Wallets use existing `hc`-gateway hooks in `lib/hooks.ts` (plus a fixed `useActivities` and a new `useAdjustWallet`). Reuses the H1 kit + theme; no `PromptSheet` needed (Users actions use a native `Alert` action sheet like `chefs.tsx`).

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, `@tesserix/homechef-shared` (types + formatters), kit in `apps/mobile/components/kit.tsx`, theme in `apps/mobile/lib/theme.ts`.

## Global Constraints

- **No RN unit-test runner.** The only gate is typecheck: `pnpm --filter @tesserix/homechef-shared build` (once) then `cd apps/mobile && npx tsc --noEmit` — clean. Every task ends with this gate + a commit. No unit tests; TDD does not apply.
- **Clients** (`apps/mobile/lib/api.ts`): `hc.get<T>(path, params?)` / `hc.post<T>(path, body?)` (prefix `/api/admin/apps/homechef/gw`); `plat.get<T>(path, params?)` (prefix `/api/admin`). All return `Promise<T>`. Errors → `apiError(e)` from `lib/api`.
- **`/activities` returns a BARE `Activity[]`, not `{ data }`** (confirmed against the Go handler). The existing `useActivities` is mistyped and must be fixed to `hc.get<Activity[]>(...)`.
- **Wallet amounts are RUPEES** (float, pass straight through `formatINR` — do NOT ÷100). Adjust body: `{ amount: number (>0), reason: string (min 3 chars), type: 'credit' | 'debit' }` → `POST /wallet/:userId/adjust`.
- **Overview Critical-24h tile is DROPPED.** The `plat` route `/apps/[product]/audit-logs?severity=critical` is NOT product-scoped server-side (always returns Mark8ly's `marketplace_api.audit_logs` count regardless of product). Showing it on the HomeChef Overview would be silently wrong, so the Overview ships Product-KPIs + Resources only. (Backend fix is out of scope for this mobile slice.)
- **`ProductKpis` is `Record<string, number>`** (not a named-field interface) — read keys `chefs_active`, `orders_today`, `gmv_today`, `approvals_pending`; treat missing keys as `undefined`. **`ProductMetrics.resources.cpu` / `.memory` are `{ current: number } | null`** — optional-chain them.
- **Palette:** no `danger` key — use `p.destructive` for raw color; kit `Badge`/`Banner` `Tone` includes `'danger'`; kit `Button` destructive = `tone="danger"`. Credit green = `p.successFg`.
- Forward-ref routes (Users → Wallets before it exists in the task order; hub → screens) use `router.push('/homechef/... ' as never)`.
- Wire dates are ISO strings. Match existing screen conventions (`chefs.tsx`, `cancellations.tsx`, `app/mark8ly/overview.tsx`): `Screen`/`ScreenHeader`+back chevron or `BackButton`, `FilterChips`, `SearchField`, `ListRow`, `Badge`, `StatGrid`/`StatTile`, `SectionLabel`, `Card`, `LoadingRows`, `EmptyState`, `Banner`, `Button`; theme tokens `usePalette`/`space`/`radius`/`text`.
- Commit messages: conventional, single-line, no signatures. Commit directly to `main`.

## Smoke-test harness (controller — user's step)

Metro 8082; dev build; sign-in user-driven. Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///homechef/overview"`. Implementers gate on `tsc` only.

## File structure

- **Modify** `apps/mobile/lib/hooks.ts` — fix `useActivities`, add `useAdjustWallet`. (Task 1)
- **Modify** `apps/mobile/lib/platform-contracts.ts` + `apps/mobile/lib/platform-hooks.ts` — `ProductKpis`/`ProductResourceMetrics` + `useProductKpis`/`useProductMetrics`. (Task 2)
- **Create** `apps/mobile/app/homechef/users.tsx`. (Task 3)
- **Create** `apps/mobile/app/homechef/wallets.tsx`. (Task 4)
- **Create** `apps/mobile/app/homechef/analytics.tsx`. (Task 5)
- **Create** `apps/mobile/app/homechef/overview.tsx`. (Task 6)
- **Modify** `apps/mobile/app/homechef/index.tsx` — add Overview group + flip 3 live. (Task 7)

---

## Task 1: Data-layer — fix `useActivities`, add `useAdjustWallet`

**Files:** Modify `apps/mobile/lib/hooks.ts`

**Interfaces:**
- Produces: `useActivities(limit?)` → `UseQueryResult<Activity[]>` (was `{ data: Activity[] }`); `useAdjustWallet(userId)` → mutation over `{ amount: number; reason: string; type: 'credit' | 'debit' }`.

- [ ] **Step 1: Fix the `useActivities` return type**

In `apps/mobile/lib/hooks.ts`, replace:
```ts
export const useActivities = (limit = 15) =>
  useQuery({ queryKey: qk.activities, queryFn: () => hc.get<{ data: Activity[] }>('/activities', { limit }) });
```
with:
```ts
export const useActivities = (limit = 15) =>
  useQuery({ queryKey: qk.activities, queryFn: () => hc.get<Activity[]>('/activities', { limit }) });
```

- [ ] **Step 2: Add the wallet-adjust mutation**

Append to `apps/mobile/lib/hooks.ts` (end of file):
```ts
// Adjust a customer wallet (credit/debit). Amounts are RUPEES. reason ≥ 3 chars.
export function useAdjustWallet(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { amount: number; reason: string; type: 'credit' | 'debit' }) =>
      hc.post(`/wallet/${userId}/adjust`, a),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.wallet(userId) }),
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
git add apps/mobile/lib/hooks.ts
git commit -m "fix(mobile): useActivities returns bare Activity[]; add useAdjustWallet"
```

---

## Task 2: Data-layer — product KPIs + resource metrics (`plat`)

**Files:** Modify `apps/mobile/lib/platform-contracts.ts`, `apps/mobile/lib/platform-hooks.ts`

**Interfaces:**
- Produces: types `ProductKpis` (`Record<string, number>`), `ProductResourceMetrics`; hooks `useProductKpis(product)` → `UseQueryResult<ProductKpis>`, `useProductMetrics(product, window?)` → `UseQueryResult<ProductResourceMetrics>`; `pk.productKpis`, `pk.productMetrics` keys.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- Product KPIs + resource metrics (per-product platform view) ------------
// KPI keys are product-config-driven (homechef: chefs_active, orders_today,
// gmv_today, approvals_pending), so this is a loose string→number map.
export type ProductKpis = Record<string, number>;

// Only the resource scalars are used on mobile; cost/email/sparklines are ignored.
// cpu/memory are nullable in the source contract, so optional-chain `.current`.
export interface ProductResourceMetrics {
  resources: {
    cpu: { current: number } | null;
    memory: { current: number } | null;
  };
}
```

- [ ] **Step 2: Add keys + hooks**

In `apps/mobile/lib/platform-hooks.ts`: add `ProductKpis`, `ProductResourceMetrics` to the `./platform-contracts` type import. Add to the `pk` object:
```ts
  productKpis: (product: string) => ['plat', 'product-kpis', product] as const,
  productMetrics: (product: string, window: string) => ['plat', 'product-metrics', product, window] as const,
```
Append the hooks (end of file):
```ts
// ---- Product KPIs + resources (per-product) ---------------------------------
export const useProductKpis = (product: string) =>
  useQuery({
    queryKey: pk.productKpis(product),
    queryFn: () => plat.get<ProductKpis>(`/apps/${product}/kpis`),
    enabled: !!product,
  });

export const useProductMetrics = (product: string, window = '24h') =>
  useQuery({
    queryKey: pk.productMetrics(product, window),
    queryFn: () => plat.get<ProductResourceMetrics>(`/apps/${product}/metrics`, { window }),
    enabled: !!product,
  });
```

- [ ] **Step 3: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/lib/platform-contracts.ts apps/mobile/lib/platform-hooks.ts
git commit -m "feat(mobile): plat hooks useProductKpis + useProductMetrics"
```

---

## Task 3: Users screen

**Files:** Create `apps/mobile/app/homechef/users.tsx`

**Interfaces:** Consumes `useUsers`, `useAdminAction` (`lib/hooks`); `formatINR`, `titleCase`, `UserWithStats` (shared); kit.

- [ ] **Step 1: Create the Users screen**

Create `apps/mobile/app/homechef/users.tsx`:
```tsx
import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useUsers, useAdminAction } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR, titleCase, type UserWithStats } from '@tesserix/homechef-shared';
import {
  Badge, EmptyState, FilterChips, ListRow, LoadingRows, Screen, ScreenHeader, SearchField, type Tone,
} from '../../components/kit';
import { usePalette, space } from '../../lib/theme';

const ROLES = [
  { key: '', label: 'All' },
  { key: 'customer', label: 'Customers' },
  { key: 'chef', label: 'Chefs' },
  { key: 'delivery', label: 'Drivers' },
  { key: 'admin', label: 'Admins' },
] as const;

export default function Users() {
  const p = usePalette();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const q = useUsers({ search: search || undefined, role: role || undefined, page: 1, limit: 50 });
  const action = useAdminAction(['hc', 'users']);
  const rows = q.data?.data ?? [];

  function act(u: UserWithStats) {
    const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
    Alert.alert(name, u.email, [
      { text: 'Open wallet', onPress: () => router.push(('/homechef/wallets?userId=' + u.id) as never) },
      {
        text: u.isActive ? 'Suspend' : 'Activate',
        style: u.isActive ? 'destructive' : 'default',
        onPress: () =>
          action.mutate(
            { method: 'put', path: `/users/${u.id}/${u.isActive ? 'suspend' : 'activate'}` },
            { onError: (e) => Alert.alert('Action failed', apiError(e)) },
          ),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  return (
    <Screen>
      <ScreenHeader
        title="Users"
        subtitle={q.data ? `${q.data.pagination.total} registered` : 'All accounts'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <SearchField value={search} onChangeText={setSearch} placeholder="Search name or email" />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={ROLES as unknown as { key: string; label: string }[]} value={role} onChange={setRole} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No users" body="Nothing matches this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(u) => u.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const name = `${item.firstName} ${item.lastName}`.trim() || item.email;
            const st: { label: string; tone: Tone } = item.isActive
              ? { label: 'Active', tone: 'success' }
              : { label: 'Suspended', tone: 'danger' };
            return (
              <ListRow
                title={name}
                subtitle={`${item.email} · ${titleCase(item.role)} · ${item.totalOrders} orders · ${formatINR(item.totalSpent)}`}
                trailing={<Badge label={st.label} tone={st.tone} />}
                onPress={() => act(item)}
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
Expected: clean (the Wallets deep-link route is built in Task 4; `as never` lets it pass). Then:
```bash
git add apps/mobile/app/homechef/users.tsx
git commit -m "feat(mobile): homechef users list (role filter, suspend/activate, wallet link)"
```

---

## Task 4: Wallets screen

**Files:** Create `apps/mobile/app/homechef/wallets.tsx`

**Interfaces:** Consumes `useWallet`, `useAdjustWallet` (`lib/hooks`); `formatINR`, `formatDateTime`, `titleCase`, `WalletTxn` (shared); kit; `useLocalSearchParams`.

- [ ] **Step 1: Create the Wallets screen**

Create `apps/mobile/app/homechef/wallets.tsx`:
```tsx
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useWallet, useAdjustWallet } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatINR, formatDateTime, titleCase, type WalletTxn } from '@tesserix/homechef-shared';
import { Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, SectionLabel } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

export default function Wallets() {
  const p = usePalette();
  const params = useLocalSearchParams<{ userId?: string }>();
  const [input, setInput] = useState(params.userId ?? '');
  const [active, setActive] = useState(params.userId ?? '');
  const [type, setType] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const q = useWallet(active);
  const adjust = useAdjustWallet(active);
  const data = q.data;

  function apply() {
    setError(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return setError('Enter an amount greater than zero.');
    if (reason.trim().length < 3) return setError('A reason of at least 3 characters is required.');
    adjust.mutate(
      { amount: amt, reason: reason.trim(), type },
      { onSuccess: () => { setAmount(''); setReason(''); }, onError: (e) => setError(apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Wallets"
        subtitle="Store credit — ledger & adjustments"
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Customer user ID"
          placeholderTextColor={p.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { flex: 1, borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
        />
        <Button label="Load" onPress={() => setActive(input.trim())} />
      </View>
      {!active ? (
        <EmptyState title="No wallet loaded" body="Enter a customer user ID, or open a wallet from Users." />
      ) : q.isLoading ? (
        <LoadingRows />
      ) : !data ? (
        <EmptyState title="No wallet found" body="No wallet for this user ID." />
      ) : (
        <FlatList
          data={data.transactions}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 12 }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: 16, marginBottom: 4 }}>
              <Card>
                <Text style={[text.caption, { color: p.mutedForeground }]}>Balance</Text>
                <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 30, color: p.foreground, marginTop: 4, fontVariant: ['tabular-nums'] }}>
                  {formatINR(data.balance)}
                </Text>
              </Card>
              <Card>
                <SectionLabel>Adjust balance</SectionLabel>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                  {(['credit', 'debit'] as const).map((t) => {
                    const on = type === t;
                    return (
                      <Pressable
                        key={t}
                        onPress={() => setType(t)}
                        style={[styles.seg, { borderColor: on ? p.primary : p.border, backgroundColor: on ? p.primary : 'transparent' }]}
                      >
                        <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: on ? p.primaryForeground : p.mutedForeground }}>
                          {t === 'credit' ? 'Credit (+)' : 'Debit (−)'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="Amount (₹)"
                  placeholderTextColor={p.mutedForeground}
                  style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted, marginBottom: 8 }]}
                />
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Reason"
                  placeholderTextColor={p.mutedForeground}
                  style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted, marginBottom: 8 }]}
                />
                {error ? (
                  <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.destructive, marginBottom: 8 }}>{error}</Text>
                ) : null}
                <Button label={adjust.isPending ? 'Saving…' : 'Apply'} onPress={apply} loading={adjust.isPending} disabled={adjust.isPending} />
              </Card>
              <SectionLabel>Ledger</SectionLabel>
            </View>
          }
          ListEmptyComponent={<Text style={[text.caption, { color: p.mutedForeground }]}>No transactions.</Text>}
          renderItem={({ item }: { item: WalletTxn }) => (
            <View style={[styles.txn, { borderColor: p.border, backgroundColor: p.surface }]}>
              <View style={{ flex: 1 }}>
                <Text style={[text.title, { color: p.foreground }]}>{titleCase(item.source)}</Text>
                {item.reason ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{item.reason}</Text> : null}
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{formatDateTime(item.createdAt)}</Text>
              </View>
              <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 15, color: item.type === 'credit' ? p.successFg : p.destructive, fontVariant: ['tabular-nums'] }}>
                {item.type === 'credit' ? '+' : '−'}{formatINR(item.amount)}
              </Text>
            </View>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { height: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 },
  seg: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  txn: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: space[3], borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
});
```

- [ ] **Step 2: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/wallets.tsx
git commit -m "feat(mobile): homechef wallets (balance, ledger, credit/debit adjust)"
```

---

## Task 5: Analytics screen

**Files:** Create `apps/mobile/app/homechef/analytics.tsx`

**Interfaces:** Consumes `useStats`, `useAnalytics`, `useActivities` (`lib/hooks`); `formatINR`, `formatCount`, `formatRelative`, `titleCase`, `Activity` (shared); kit.

- [ ] **Step 1: Create the Analytics screen**

Create `apps/mobile/app/homechef/analytics.tsx`:
```tsx
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useStats, useAnalytics, useActivities } from '../../lib/hooks';
import { formatINR, formatCount, formatRelative, titleCase, type Activity } from '@tesserix/homechef-shared';
import { BackButton, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

function delta(n: number | undefined): string {
  if (n == null) return '—';
  return `${n >= 0 ? '▲' : '▼'} ${Math.abs(n).toFixed(1)}%`;
}

export default function Analytics() {
  const p = usePalette();
  const stats = useStats();
  const analytics = useAnalytics();
  const activity = useActivities(12);
  const s = stats.data;
  const a = analytics.data;
  const activities = activity.data ?? [];
  const refreshing = stats.isRefetching || analytics.isRefetching || activity.isRefetching;
  const refetchAll = () => { stats.refetch(); analytics.refetch(); activity.refetch(); };

  const statusRows = Object.entries(a?.ordersByStatus ?? {})
    .map(([k, v]) => ({ label: titleCase(k), count: v }))
    .sort((x, y) => y.count - x.count);
  const maxCount = statusRows.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <Screen>
      <ScreenHeader title="Analytics" subtitle="Platform performance · live" right={<BackButton onPress={() => router.back()} />} />
      {stats.isLoading && !s ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Money & volume</SectionLabel></View>
          <StatGrid>
            <StatTile label="Total revenue" value={formatINR(s?.revenue)} tone={s && s.revenueChange >= 0 ? 'success' : 'danger'} />
            <StatTile label="Revenue today" value={formatINR(s?.revenueToday)} />
            <StatTile label="Total orders" value={formatCount(s?.totalOrders)} />
            <StatTile label="Orders today" value={formatCount(s?.ordersToday)} />
          </StatGrid>
          <View style={{ paddingHorizontal: space[4] }}>
            <Text style={[text.caption, { color: p.mutedForeground }]}>
              Revenue {delta(s?.revenueChange)} · Orders {delta(s?.ordersChange)} vs prev.
            </Text>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>People & efficiency</SectionLabel></View>
          <StatGrid>
            <StatTile label="Avg order value" value={formatINR(a?.overview.avgOrderValue)} />
            <StatTile label="Total users" value={formatCount(s?.totalUsers)} />
            <StatTile label="Active users" value={formatCount(a?.overview.activeUsers)} tone="info" />
            <StatTile label="Chefs" value={formatCount(s?.totalChefs)} tone={s?.pendingVerifications ? 'warning' : 'neutral'} />
          </StatGrid>
          {s?.pendingVerifications || s?.newUsersToday ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Text style={[text.caption, { color: p.mutedForeground }]}>
                {s?.pendingVerifications ? `${s.pendingVerifications} chef verification(s) pending · ` : ''}
                {formatCount(s?.newUsersToday)} new users today
              </Text>
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Orders by status</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4] }}>
            {statusRows.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No order data yet.</Text>
            ) : (
              <Card>
                <View style={{ gap: 10 }}>
                  {statusRows.map((r) => (
                    <View key={r.label} style={{ gap: 4 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={[text.caption, { color: p.foreground }]}>{r.label}</Text>
                        <Text style={[text.caption, { color: p.mutedForeground, fontVariant: ['tabular-nums'] }]}>{formatCount(r.count)}</Text>
                      </View>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: p.muted, overflow: 'hidden' }}>
                        <View style={{ width: `${maxCount > 0 ? (r.count / maxCount) * 100 : 0}%`, height: 6, backgroundColor: p.primary }} />
                      </View>
                    </View>
                  ))}
                </View>
              </Card>
            )}
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Recent activity</SectionLabel></View>
          <View style={{ paddingHorizontal: space[4] }}>
            <Card>
              {activities.length === 0 ? (
                <Text style={[text.caption, { color: p.mutedForeground }]}>No recent activity.</Text>
              ) : (
                <View style={{ gap: 12 }}>
                  {activities.map((act: Activity) => (
                    <View key={act.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{act.title}</Text>
                        <Text style={[text.caption, { color: p.mutedForeground }]} numberOfLines={1}>{act.description}</Text>
                      </View>
                      <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(act.timestamp)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </Card>
          </View>
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
git add apps/mobile/app/homechef/analytics.tsx
git commit -m "feat(mobile): homechef analytics (KPIs, orders-by-status bars, activity)"
```

---

## Task 6: Overview screen

**Files:** Create `apps/mobile/app/homechef/overview.tsx`

**Interfaces:** Consumes `useProductKpis`, `useProductMetrics` (`lib/platform-hooks`); `formatINR`, `formatCount`, `formatBytes` (shared); kit.

- [ ] **Step 1: Create the Overview screen**

Create `apps/mobile/app/homechef/overview.tsx`:
```tsx
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useProductKpis, useProductMetrics } from '../../lib/platform-hooks';
import { formatINR, formatCount, formatBytes } from '@tesserix/homechef-shared';
import { BackButton, Banner, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { space } from '../../lib/theme';

const PRODUCT = 'homechef';

export default function Overview() {
  const kpis = useProductKpis(PRODUCT);
  const metrics = useProductMetrics(PRODUCT);
  const k = kpis.data;
  const res = metrics.data?.resources;
  const refreshing = kpis.isRefetching || metrics.isRefetching;
  const refetchAll = () => { kpis.refetch(); metrics.refetch(); };
  const num = (key: string): number | undefined => (k && key in k ? k[key] : undefined);

  return (
    <Screen>
      <ScreenHeader title="HomeChef" subtitle="Overview" right={<BackButton onPress={() => router.back()} />} />
      {kpis.isLoading || metrics.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          {kpis.isError ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Banner text="Some data could not be loaded." tone="danger" />
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Business</SectionLabel></View>
          <StatGrid>
            <StatTile label="Active chefs" value={formatCount(num('chefs_active'))} />
            <StatTile label="Orders today" value={formatCount(num('orders_today'))} />
            <StatTile label="GMV today" value={formatINR(num('gmv_today'))} />
            <StatTile label="Pending approvals" value={formatCount(num('approvals_pending'))} tone={num('approvals_pending') ? 'warning' : 'neutral'} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Resources (24h)</SectionLabel></View>
          <StatGrid>
            <StatTile label="CPU" value={res?.cpu ? `${formatCount(res.cpu.current)} cores` : '—'} />
            <StatTile label="Memory" value={res?.memory ? formatBytes(res.memory.current) : '—'} />
          </StatGrid>
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
git add apps/mobile/app/homechef/overview.tsx
git commit -m "feat(mobile): homechef overview (product KPIs + resources)"
```

---

## Task 7: Hub wiring + final gate

**Files:** Modify `apps/mobile/app/homechef/index.tsx`

- [ ] **Step 1: Add the Overview group and flip three rows live**

In `apps/mobile/app/homechef/index.tsx`:

(a) Add `LayoutDashboard` to the `lucide-react-native` icon import (alongside the existing icons).

(b) In the `SECTIONS` array, add a new **first** group:
```ts
  { group: 'Overview', items: [
    { title: 'Overview', sub: 'KPIs + resources', icon: LayoutDashboard, route: '/homechef/overview', live: true },
  ]},
```
(c) Flip `live: false` → `live: true` on exactly these three existing rows (leave all others unchanged):
- `Users` (People & quality): `{ title: 'Users', sub: 'Customers, chefs, drivers', icon: Users, route: '/homechef/users', live: true },`
- `Wallets` (Money): `{ title: 'Wallets', sub: 'Customer credit', icon: Wallet, route: '/homechef/wallets', live: true },`
- `Analytics` (People & quality): `{ title: 'Analytics', sub: 'KPIs + trends', icon: BarChart3, route: '/homechef/analytics', live: true },`

- [ ] **Step 2: Full-slice gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean across the whole slice. Then:
```bash
git add apps/mobile/app/homechef/index.tsx
git commit -m "feat(mobile): homechef hub — Overview, Users, Wallets, Analytics live"
```

---

## Self-review (completed during authoring)

- **Spec coverage:** Overview (T6, plat KPIs+resources; Critical tile dropped per backend finding), Analytics (T5, KPI tiles + orders-by-status bars + activity), Users (T3, role filter + suspend/activate + wallet link), Wallets (T4, load + balance + ledger + adjust), data layer (T1 useActivities fix + useAdjustWallet, T2 product hooks), hub wiring (T7). All spec screens covered.
- **Placeholder scan:** no TBD/TODO; every step carries full code or an exact edit.
- **Type consistency:** `useAdjustWallet(active)` mutate arg `{ amount, reason, type }` matches T4 call; `useProductKpis`/`useProductMetrics(product)` signatures match T6 calls; `useActivities` now returns `Activity[]`, consumed as `activity.data ?? []` in T5; `useAdminAction(['hc','users'])` arg `{ method:'put', path }` matches T3; `WalletTxn`/`UserWithStats`/`Activity`/`AdminStats`/`AdminAnalytics` fields match the extracted shared contracts (`overview.avgOrderValue`/`.activeUsers`, `ordersByStatus: Record<string,number>`, txn `{id,source,reason,createdAt,type,amount}`); palette `p.successFg`/`p.destructive`/`p.primaryForeground` all exist.
- **Units:** wallet amounts pass straight through `formatINR` (rupees), adjust posts raw rupees — matches backend `binding:"required,gt=0"` + `min=3` on reason.
- **Routing:** all four are flat files (`overview/analytics/users/wallets.tsx`); Users→Wallets deep-link via `?userId=` + `as never` (built after Users in the task order).
