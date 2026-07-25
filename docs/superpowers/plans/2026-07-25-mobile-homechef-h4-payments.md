# Mobile HomeChef — Sub-slice H4: Payments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HomeChef mobile Payouts (weekly statements + mark-paid), Payout Setup (blocked chefs + automation toggle), Payout Queue (escrow release/withhold/reverse + bulk-release), Refund Payouts (execute meal-plan refunds), and a read-only Payment Gateway status view — and add a new "Payments" hub group.

**Architecture:** expo-router screens under `apps/mobile/app/homechef/`. Four screens use new `hc`-gateway hooks in `lib/hooks.ts`; Payouts uses new `plat` hooks in `lib/platform-hooks.ts`. Reuses the H1 `useConfirm` primitive + kit/theme. Money is rupees throughout (no ÷100).

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, `@tesserix/homechef-shared`, kit in `apps/mobile/components/kit.tsx`, theme in `apps/mobile/lib/theme.ts`.

## Global Constraints

- **No RN unit-test runner.** Only gate is typecheck: `pnpm --filter @tesserix/homechef-shared build` (once) then `cd apps/mobile && npx tsc --noEmit` — clean. Every task ends with this gate + a commit. No unit tests; TDD does not apply.
- **Clients** (`apps/mobile/lib/api.ts`): `hc.get<T>(path, params?)` / `hc.post<T>(path, body?)` / `hc.put<T>(path, body?)` (prefix `/api/admin/apps/homechef/gw`); `plat.get<T>(path, params?)` / `plat.put<T>(path, body?)` (prefix `/api/admin`). All return `Promise<T>`. Errors → `apiError(e)`.
- **All amounts are RUPEES** (`formatINR` straight through — NEVER ÷100).
- **Shared types (exported from `@tesserix/homechef-shared`):** `BlockedChef`, `BlockedChefsResponse`, `PayoutAutomationValue` (`'on'|'off'|''`), `parseSettlementRequirements` + `SettlementRequirement` (`{ field_reference?, reason_code?, resolution_url? }`; returns `SettlementRequirement[] | null`), `PendingPayout`, `PendingPayoutsResponse` (`{ payouts, count }` — NO eligible count, compute client-side), `PayoutHoldStatus`, `PaymentGatewayStatus` (`{ configured, mode, webhookUrl, webhookSecretSet, keyPrefix, error }` — NO `keySecretSet`, reuse `configured`), `StripeGatewayStatus` (extends + `publishableKeySet`), `formatINR`, `formatDate`, `titleCase`.
- **`PendingPayout` fields:** `aggType: 'order'|'meal-plan-day'|'group-order'`, `id`, `chefId`, `amount` (gross), `netPayout`, `holdStatus`, `deliveredAt?`, `ageHours`, `customerConfirmedAt?`, `hasOpenIssue?`, `context`. URL is `/payouts/${aggType}/${id}/${action}`. Bulk body: `{ items: [{ aggType, id }] }` (camelCase).
- **Local types (re-declared in mobile):** `StatementRow`/`StatementsResponse` (payouts, plat, snake_case; pagination has only `{page,limit,total,totalPages}`); `PendingRefundDay` (refund-payouts, hc).
- **Payment Gateway is READ-ONLY** — status GETs only, no PUT/forms. `execute-refund` response is opaque (unused).
- Palette: no `danger` key — kit `Badge`/`Button` use `tone="danger"`; raw destructive color is `p.destructive`. Wire dates ISO strings.
- Match existing conventions (`chefs.tsx`, `delivery.tsx`, `fssai.tsx`): kit components, theme tokens, `Screen`/`ScreenHeader`+back chevron, `Card`, `Badge`, `Button`, `FilterChips`, `LoadingRows`, `EmptyState`; `useConfirm` for confirm/reason prompts.
- Commit messages: conventional, single-line, no signatures. Commit directly to `main`.

## Smoke-test harness (controller — user's step)

Metro 8082; dev build; sign-in user-driven. Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///homechef/payout-queue"`. Implementers gate on `tsc` only.

## File structure

- **Modify** `apps/mobile/lib/hooks.ts` — all hc payments hooks + local `PendingRefundDay`. (Task 1)
- **Modify** `apps/mobile/lib/platform-contracts.ts` + `apps/mobile/lib/platform-hooks.ts` — `StatementRow`/`StatementsResponse` + `useStatements`/`useMarkPaid`. (Task 2)
- **Create** `apps/mobile/app/homechef/payout-queue.tsx`. (Task 3)
- **Create** `apps/mobile/app/homechef/payout-setup.tsx`. (Task 4)
- **Create** `apps/mobile/app/homechef/refund-payouts.tsx`. (Task 5)
- **Create** `apps/mobile/app/homechef/payment-gateway.tsx`. (Task 6)
- **Create** `apps/mobile/app/homechef/payouts.tsx`. (Task 7)
- **Modify** `apps/mobile/app/homechef/index.tsx` — new Payments group, move Payouts out of Money. (Task 8)

---

## Task 1: Data-layer — hc payments hooks

**Files:** Modify `apps/mobile/lib/hooks.ts`

**Interfaces:** Produces `useBlockedChefs`, `useSetPayoutAutomation`, `usePendingPayouts(includeAwaiting)`, `usePayoutAction`, `useBulkReleasePayouts`, `usePendingRefunds`, `useExecuteRefund`, `useGatewayStatus`, `useStripeStatus`; type `PendingRefundDay`; `qk` keys `blockedChefs`, `pendingPayouts`, `pendingRefunds`, `gatewayStatus`, `stripeStatus`.

- [ ] **Step 1: Extend the shared type import**

Add to the `@tesserix/homechef-shared` type import block in `apps/mobile/lib/hooks.ts`:
```ts
  BlockedChefsResponse,
  PayoutAutomationValue,
  PendingPayoutsResponse,
  PaymentGatewayStatus,
  StripeGatewayStatus,
```

- [ ] **Step 2: Add the local type + qk keys**

After the existing local types block (near `BackfillResponse`), add:
```ts
export interface PendingRefundDay {
  dayId: string;
  date: string;
  slot: string;
  dishName: string;
  customerName: string;
  chefName: string;
  mealPlanNumber: string;
  chefChoice: string; // full | half
  refundAmount: number;
}
```
Add to the `qk` object:
```ts
  blockedChefs: ['hc', 'blocked-chefs'] as const,
  pendingPayouts: (include: string) => ['hc', 'pending-payouts', include] as const,
  pendingRefunds: ['hc', 'pending-refunds'] as const,
  gatewayStatus: ['hc', 'gateway-status'] as const,
  stripeStatus: ['hc', 'stripe-status'] as const,
```

- [ ] **Step 3: Append the hooks**

Append to end of `apps/mobile/lib/hooks.ts`:
```ts
// ---- Payout setup: blocked chefs + automation toggle -----------------------
export const useBlockedChefs = () =>
  useQuery({ queryKey: qk.blockedChefs, queryFn: () => hc.get<BlockedChefsResponse>('/payouts/blocked-chefs') });

export function useSetPayoutAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { chefId: string; value: PayoutAutomationValue }) =>
      hc.put(`/chefs/${a.chefId}/payout-automation`, { value: a.value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.blockedChefs }),
  });
}

// ---- Payout queue: escrow release/withhold/reverse + bulk -------------------
export const usePendingPayouts = (includeAwaiting: boolean) =>
  useQuery({
    queryKey: qk.pendingPayouts(includeAwaiting ? 'awaiting' : 'eligible'),
    queryFn: () =>
      hc.get<PendingPayoutsResponse>('/payouts/pending', includeAwaiting ? { include: 'awaiting' } : undefined),
    refetchInterval: 30_000,
  });

// release (no reason) | withhold | reverse (reason) — path built by the caller.
export function usePayoutAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { path: string; reason?: string }) =>
      hc.post(a.path, a.reason !== undefined ? { reason: a.reason } : undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'pending-payouts'] }),
  });
}

export function useBulkReleasePayouts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: { aggType: string; id: string }[]) => hc.post('/payouts/release-bulk', { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'pending-payouts'] }),
  });
}

// ---- Refund payouts --------------------------------------------------------
export const usePendingRefunds = () =>
  useQuery({
    queryKey: qk.pendingRefunds,
    queryFn: () => hc.get<{ data: PendingRefundDay[] }>('/meal-plan-days/pending-refunds'),
  });

export function useExecuteRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dayId: string) => hc.post(`/meal-plan-days/${dayId}/execute-refund`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.pendingRefunds }),
  });
}

// ---- Payment gateway status (read-only) ------------------------------------
export const useGatewayStatus = () =>
  useQuery({ queryKey: qk.gatewayStatus, queryFn: () => hc.get<PaymentGatewayStatus>('/payment-gateway/status') });
export const useStripeStatus = () =>
  useQuery({ queryKey: qk.stripeStatus, queryFn: () => hc.get<StripeGatewayStatus>('/payment-gateway/stripe/status') });
```

- [ ] **Step 4: Gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): hc payments hooks — payouts queue/setup, refunds, gateway status"
```

---

## Task 2: Data-layer — plat statements hooks

**Files:** Modify `apps/mobile/lib/platform-contracts.ts`, `apps/mobile/lib/platform-hooks.ts`

**Interfaces:** Produces types `StatementRow`, `StatementsResponse`; hooks `useStatements({status?,page?})` → `UseQueryResult<StatementsResponse>`, `useMarkPaid()` → mutation over `{ id, payoutRef }`; `pk.statements` key.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- HomeChef weekly settlement statements (plat route, snake_case wire) -----
export interface StatementRow {
  id: string;
  chef_id: string;
  chef_name: string | null;
  week_start: string;
  week_end: string;
  currency: string;
  orders_count: number;
  gross_revenue: number;
  platform_commission: number;
  cgst: number;
  sgst: number;
  igst: number;
  tds: number;
  net_payout: number;
  status: string;
  paid_at: string | null;
  payout_ref: string | null;
}
export interface StatementsResponse {
  data: StatementRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
```

- [ ] **Step 2: Add key + hooks**

In `apps/mobile/lib/platform-hooks.ts`: add `StatementRow`, `StatementsResponse` to the `./platform-contracts` type import. Add to `pk`:
```ts
  statements: (p: object) => ['plat', 'statements', p] as const,
```
Append the hooks (end of file):
```ts
// ---- HomeChef weekly settlement statements ----------------------------------
export const useStatements = (p: { status?: string; page?: number }) =>
  useQuery({ queryKey: pk.statements(p), queryFn: () => plat.get<StatementsResponse>('/apps/homechef/payouts', p) });

export function useMarkPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; payoutRef: string }) =>
      plat.put(`/apps/homechef/payouts/${a.id}/mark-paid`, { payoutRef: a.payoutRef }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plat', 'statements'] }),
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
git commit -m "feat(mobile): plat hooks for homechef settlement statements + mark-paid"
```

---

## Task 3: Payout Queue screen

**Files:** Create `apps/mobile/app/homechef/payout-queue.tsx`

**Interfaces:** Consumes `usePendingPayouts`/`usePayoutAction`/`useBulkReleasePayouts` (`lib/hooks`); `useConfirm` (prompt); `formatINR`/`titleCase`/`PendingPayout`/`PayoutHoldStatus` (shared); `apiError`; kit.

- [ ] **Step 1: Create the Payout Queue screen**

Create `apps/mobile/app/homechef/payout-queue.tsx`:
```tsx
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { usePendingPayouts, usePayoutAction, useBulkReleasePayouts } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, titleCase, type PendingPayout, type PayoutHoldStatus } from '@tesserix/homechef-shared';
import { Badge, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const SLA_HOURS = 24;

function holdTone(status: PayoutHoldStatus): Tone {
  switch (status) {
    case 'release_eligible': return 'success';
    case 'awaiting_customer_confirmation':
    case 'withheld': return 'warning';
    case 'released': return 'info';
    case 'reversed':
    case 'disputed': return 'danger';
    default: return 'neutral';
  }
}
function ageLabel(hours: number): { label: string; overdue: boolean } {
  const rounded = Math.max(0, Math.round(hours));
  const label = rounded >= 48 ? `${Math.round(rounded / 24)}d` : `${rounded}h`;
  return { label, overdue: hours > SLA_HOURS };
}
function aggLabel(aggType: PendingPayout['aggType']): string {
  return aggType === 'meal-plan-day' ? 'Tiffin day' : aggType === 'group-order' ? 'Group order' : 'Order';
}

export default function PayoutQueue() {
  const p = usePalette();
  const [includeAwaiting, setIncludeAwaiting] = useState(false);
  const q = usePendingPayouts(includeAwaiting);
  const action = usePayoutAction();
  const bulk = useBulkReleasePayouts();
  const { confirm, prompt } = useConfirm();
  const rows = q.data?.payouts ?? [];
  const eligible = rows.filter((x) => x.holdStatus === 'release_eligible' && !x.hasOpenIssue);
  const busy = action.isPending || bulk.isPending;

  async function release(pp: PendingPayout) {
    const ok = await confirm({
      title: 'Release payout',
      message: pp.hasOpenIssue
        ? `This hold has an OPEN ISSUE. Release ${formatINR(pp.netPayout)} to the chef anyway?`
        : `Release ${formatINR(pp.netPayout)} to the chef?`,
      confirmLabel: 'Release',
      tone: pp.hasOpenIssue ? 'destructive' : 'default',
    });
    if (!ok) return;
    action.mutate({ path: `/payouts/${pp.aggType}/${pp.id}/release` }, { onError: (e) => Alert.alert('Release failed', apiError(e)) });
  }
  async function withhold(pp: PendingPayout) {
    const reason = await prompt({
      title: 'Withhold payout', message: 'Park this hold. A reason is required.',
      label: 'Reason', multiline: true, required: true, confirmLabel: 'Withhold',
    });
    if (reason === null) return;
    action.mutate({ path: `/payouts/${pp.aggType}/${pp.id}/withhold`, reason }, { onError: (e) => Alert.alert('Withhold failed', apiError(e)) });
  }
  async function reverse(pp: PendingPayout) {
    const reason = await prompt({
      title: 'Reverse payout', message: 'Claw back an already-released payout. A reason is required.',
      label: 'Reason', multiline: true, required: true, confirmLabel: 'Reverse', tone: 'destructive',
    });
    if (reason === null) return;
    action.mutate({ path: `/payouts/${pp.aggType}/${pp.id}/reverse`, reason }, { onError: (e) => Alert.alert('Reverse failed', apiError(e)) });
  }
  async function releaseAll() {
    if (eligible.length === 0) return;
    const ok = await confirm({ title: 'Release all', message: `Release ${eligible.length} eligible payout(s) to chefs?`, confirmLabel: `Release ${eligible.length}` });
    if (!ok) return;
    bulk.mutate(eligible.map((x) => ({ aggType: x.aggType, id: x.id })), { onError: (e) => Alert.alert('Bulk release failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Payout queue"
        subtitle={q.data ? `${q.data.count} holds · ${eligible.length} eligible` : 'Escrow release'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 12 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label={eligible.length > 0 ? `Release all (${eligible.length})` : 'Release all'} disabled={busy || eligible.length === 0} onPress={releaseAll} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label={includeAwaiting ? 'Eligible only' : 'Include awaiting'} variant="secondary" onPress={() => setIncludeAwaiting((v) => !v)} />
            </View>
          </View>
          {rows.length === 0 ? (
            <EmptyState title="Queue empty" body="No holds to release." />
          ) : (
            rows.map((pp) => {
              const age = ageLabel(pp.ageHours);
              return (
                <Card key={`${pp.aggType}-${pp.id}`}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]} numberOfLines={1}>{pp.context || aggLabel(pp.aggType)}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {aggLabel(pp.aggType)} · {pp.customerConfirmedAt ? 'confirmed' : 'auto'} · {formatINR(pp.amount)} gross
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 16, color: p.foreground, fontVariant: ['tabular-nums'] }}>{formatINR(pp.netPayout)}</Text>
                      <Badge label={age.label} tone={age.overdue ? 'danger' : 'neutral'} />
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <Badge label={titleCase(pp.holdStatus)} tone={holdTone(pp.holdStatus)} />
                    {pp.hasOpenIssue ? <Badge label="Open issue" tone="danger" /> : null}
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    <Button label="Release" disabled={busy} tone={pp.hasOpenIssue ? 'danger' : 'default'} onPress={() => release(pp)} />
                    <Button label="Withhold" variant="secondary" disabled={busy} onPress={() => withhold(pp)} />
                    <Button label="Reverse" variant="secondary" tone="danger" disabled={busy} onPress={() => reverse(pp)} />
                  </View>
                </Card>
              );
            })
          )}
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
git add apps/mobile/app/homechef/payout-queue.tsx
git commit -m "feat(mobile): homechef payout queue (release/withhold/reverse + bulk)"
```

---

## Task 4: Payout Setup screen

**Files:** Create `apps/mobile/app/homechef/payout-setup.tsx`

**Interfaces:** Consumes `useBlockedChefs`/`useSetPayoutAutomation` (`lib/hooks`); `useConfirm`; `titleCase`/`parseSettlementRequirements`/`BlockedChef`/`PayoutAutomationValue` (shared); `apiError`; kit.

- [ ] **Step 1: Create the Payout Setup screen**

Create `apps/mobile/app/homechef/payout-setup.tsx`:
```tsx
import { Alert, Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useBlockedChefs, useSetPayoutAutomation } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { titleCase, parseSettlementRequirements, type BlockedChef, type PayoutAutomationValue } from '@tesserix/homechef-shared';
import { Badge, Card, EmptyState, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const AUTOMATION_OPTIONS: { value: PayoutAutomationValue; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: '', label: 'Default' },
];
function settlementTone(status: string): Tone {
  switch (status) {
    case 'needs_clarification': return 'warning';
    case 'created': return 'info';
    case 'activated': return 'success';
    default: return 'neutral';
  }
}
function settlementLabel(status: string): string {
  return status ? titleCase(status) : 'Not started';
}
function noRequirementsNote(status: string): string {
  switch (status) {
    case 'needs_clarification': return 'Razorpay flagged this account but returned no specific field.';
    case 'created': return 'Awaiting Razorpay review.';
    default: return 'Chef has not submitted bank details.';
  }
}

function Requirements({ chef }: { chef: BlockedChef }) {
  const p = usePalette();
  if (!chef.requirements) return <Text style={[text.caption, { color: p.mutedForeground }]}>{noRequirementsNote(chef.settlementStatus)}</Text>;
  const parsed = parseSettlementRequirements(chef.requirements);
  if (parsed === null) return <Text style={[text.caption, { color: p.mutedForeground }]}>{chef.requirements}</Text>;
  if (parsed.length === 0) return <Text style={[text.caption, { color: p.mutedForeground }]}>{noRequirementsNote(chef.settlementStatus)}</Text>;
  return (
    <View style={{ gap: 6 }}>
      {parsed.map((r, i) => {
        const field = r.field_reference ? titleCase(r.field_reference.replace(/[._]+/g, ' ')) : 'Unspecified field';
        const reason = r.reason_code ? ` — ${titleCase(r.reason_code)}` : '';
        const url = r.resolution_url;
        return (
          <View key={i}>
            <Text style={[text.body, { color: p.foreground }]}>{field}{reason}</Text>
            {url ? (
              <Text onPress={() => Linking.openURL(url)} style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: p.primary, marginTop: 2 }}>Resolve →</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export default function PayoutSetup() {
  const p = usePalette();
  const q = useBlockedChefs();
  const setAuto = useSetPayoutAutomation();
  const { confirm } = useConfirm();
  const chefs = q.data?.chefs ?? [];

  async function pick(chef: BlockedChef, value: PayoutAutomationValue) {
    if (value === chef.payoutAutoRelease) return;
    if (value === 'off') {
      const ok = await confirm({
        title: 'Turn off automation',
        message: `${chef.businessName} will need manual release via the queue until re-enabled. Continue?`,
        confirmLabel: 'Turn off', tone: 'destructive',
      });
      if (!ok) return;
    }
    setAuto.mutate({ chefId: chef.chefId, value }, { onError: (e) => Alert.alert('Update failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Payout setup"
        subtitle={q.data ? `${chefs.length} blocked` : 'Blocked chefs'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : chefs.length === 0 ? (
        <EmptyState title="No blocked chefs" body="Everyone can receive payouts." />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 12 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {chefs.map((chef) => (
            <Card key={chef.chefId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Text style={[text.title, { color: p.foreground, flex: 1 }]}>{chef.businessName}</Text>
                <Badge label={settlementLabel(chef.settlementStatus)} tone={settlementTone(chef.settlementStatus)} />
              </View>
              <Text style={[text.label, { color: p.mutedForeground, marginTop: 12, marginBottom: 4 }]}>What Razorpay needs</Text>
              <Requirements chef={chef} />
              <Text style={[text.label, { color: p.mutedForeground, marginTop: 12, marginBottom: 6 }]}>Payout automation</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {AUTOMATION_OPTIONS.map((o) => {
                  const on = chef.payoutAutoRelease === o.value;
                  return (
                    <Pressable
                      key={o.value || 'default'}
                      onPress={() => pick(chef, o.value)}
                      disabled={setAuto.isPending}
                      style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: on ? p.primary : p.border, backgroundColor: on ? p.primary : 'transparent' }}
                    >
                      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: on ? p.primaryForeground : p.mutedForeground }}>{o.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Card>
          ))}
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
git add apps/mobile/app/homechef/payout-setup.tsx
git commit -m "feat(mobile): homechef payout setup (blocked chefs + automation toggle)"
```

---

## Task 5: Refund Payouts screen

**Files:** Create `apps/mobile/app/homechef/refund-payouts.tsx`

**Interfaces:** Consumes `usePendingRefunds`/`useExecuteRefund`/`PendingRefundDay` (`lib/hooks`); `useConfirm`; `formatINR`/`titleCase` (shared); `apiError`; kit.

- [ ] **Step 1: Create the Refund Payouts screen**

Create `apps/mobile/app/homechef/refund-payouts.tsx`:
```tsx
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { usePendingRefunds, useExecuteRefund, type PendingRefundDay } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, titleCase } from '@tesserix/homechef-shared';
import { Badge, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

export default function RefundPayouts() {
  const p = usePalette();
  const q = usePendingRefunds();
  const execute = useExecuteRefund();
  const { confirm } = useConfirm();
  const rows = q.data?.data ?? [];

  async function run(row: PendingRefundDay) {
    const ok = await confirm({
      title: 'Execute refund',
      message: `Refund ${formatINR(row.refundAmount)} to ${row.customerName} for ${row.dishName} (${row.date} ${row.slot})? This triggers a real Razorpay reversal (5–7 business days).`,
      confirmLabel: 'Execute refund',
    });
    if (!ok) return;
    execute.mutate(row.dayId, { onError: (e) => Alert.alert('Refund failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Refund payouts"
        subtitle={q.data ? `${rows.length} pending` : 'Meal-plan refunds'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No refunds pending" body="Approved meal-plan refunds show up here." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.dayId}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => (
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={[text.title, { color: p.foreground }]}>{item.dishName}</Text>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{item.date} · {item.slot} · {item.customerName}</Text>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{item.chefName} · plan {item.mealPlanNumber}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 16, color: p.foreground, fontVariant: ['tabular-nums'] }}>{formatINR(item.refundAmount)}</Text>
                  <Badge label={titleCase(item.chefChoice)} tone={item.chefChoice === 'full' ? 'danger' : 'warning'} />
                </View>
              </View>
              <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                <Button label="Execute refund" disabled={execute.isPending} onPress={() => run(item)} />
              </View>
            </Card>
          )}
          ListFooterComponent={
            <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12 }]}>
              Refund covers food + delivery fee, excluding GST + platform fee.
            </Text>
          }
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
git add apps/mobile/app/homechef/refund-payouts.tsx
git commit -m "feat(mobile): homechef refund payouts (execute meal-plan refunds)"
```

---

## Task 6: Payment Gateway screen (read-only)

**Files:** Create `apps/mobile/app/homechef/payment-gateway.tsx`

**Interfaces:** Consumes `useGatewayStatus`/`useStripeStatus` (`lib/hooks`); `PaymentGatewayStatus`/`StripeGatewayStatus` (shared); kit.

- [ ] **Step 1: Create the Payment Gateway screen**

Create `apps/mobile/app/homechef/payment-gateway.tsx`:
```tsx
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useGatewayStatus, useStripeStatus } from '../../lib/hooks';
import type { PaymentGatewayStatus } from '@tesserix/homechef-shared';
import { Badge, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, type Tone } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

function modeMeta(s: PaymentGatewayStatus): { label: string; tone: Tone } {
  if (!s.configured) return { label: 'Not configured', tone: 'neutral' };
  if (s.mode === 'live') return { label: 'LIVE', tone: 'warning' };
  return { label: 'Test mode', tone: 'info' };
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
      <Text style={[text.body, { color: p.foreground }]}>{label}</Text>
      <Badge label={ok ? 'Set' : 'Missing'} tone={ok ? 'success' : 'neutral'} />
    </View>
  );
}

function GatewayCard({ title, s, secretLabel, extraLabel, extraOk }: {
  title: string; s: PaymentGatewayStatus; secretLabel: string; extraLabel?: string; extraOk?: boolean;
}) {
  const p = usePalette();
  const m = modeMeta(s);
  return (
    <View>
      <SectionLabel>{title}</SectionLabel>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={[text.title, { color: p.foreground }]}>{title}</Text>
          <Badge label={m.label} tone={m.tone} />
        </View>
        <StatusRow label={secretLabel} ok={s.configured} />
        {extraLabel ? <StatusRow label={extraLabel} ok={!!extraOk} /> : null}
        <StatusRow label="Webhook secret" ok={s.webhookSecretSet} />
        {s.keyPrefix ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>Key: {s.keyPrefix}…</Text> : null}
        {s.webhookUrl ? <Text style={[text.mono, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{s.webhookUrl}</Text> : null}
      </Card>
    </View>
  );
}

export default function PaymentGateway() {
  const p = usePalette();
  const rz = useGatewayStatus();
  const st = useStripeStatus();

  return (
    <Screen>
      <ScreenHeader
        title="Payment gateway"
        subtitle="Razorpay + Stripe · read-only"
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      {rz.isLoading || st.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
          {rz.data ? <GatewayCard title="Razorpay" s={rz.data} secretLabel="Key secret" /> : null}
          {st.data ? <GatewayCard title="Stripe" s={st.data} secretLabel="Secret key" extraLabel="Publishable key" extraOk={st.data.publishableKeySet} /> : null}
          <Text style={[text.caption, { color: p.mutedForeground }]}>Credentials are managed on the web admin.</Text>
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
git add apps/mobile/app/homechef/payment-gateway.tsx
git commit -m "feat(mobile): homechef payment gateway status (read-only)"
```

---

## Task 7: Payouts screen

**Files:** Create `apps/mobile/app/homechef/payouts.tsx`

**Interfaces:** Consumes `useStatements`/`useMarkPaid` (`lib/platform-hooks`), `StatementRow` (`lib/platform-contracts`); `useConfirm`; `formatINR`/`formatDate`/`titleCase` (shared); `apiError`; kit.

- [ ] **Step 1: Create the Payouts screen**

Create `apps/mobile/app/homechef/payouts.tsx`:
```tsx
import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useStatements, useMarkPaid } from '../../lib/platform-hooks';
import type { StatementRow } from '../../lib/platform-contracts';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatINR, formatDate, titleCase } from '@tesserix/homechef-shared';
import { Badge, Button, Card, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, type Tone } from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const STATUSES = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'paid', label: 'Paid' },
] as const;

function statusTone(s: string): Tone {
  if (s === 'paid') return 'success';
  if (s === 'pending') return 'warning';
  return 'neutral';
}

export default function Payouts() {
  const p = usePalette();
  const [status, setStatus] = useState('');
  const q = useStatements({ status: status || undefined, page: 1 });
  const markPaid = useMarkPaid();
  const { prompt } = useConfirm();
  const rows = q.data?.data ?? [];

  async function mark(row: StatementRow) {
    const ref = await prompt({
      title: 'Mark paid',
      message: `Record a disbursement reference for ${row.chef_name ?? row.chef_id}'s ${formatINR(row.net_payout)} payout. Enter this only after the transfer has actually been sent.`,
      label: 'Payout reference', required: true, confirmLabel: 'Mark paid',
    });
    if (ref === null) return;
    markPaid.mutate({ id: row.id, payoutRef: ref }, { onError: (e) => Alert.alert('Failed', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Payouts"
        subtitle={q.data ? `${q.data.pagination.total} statements` : 'Weekly settlements'}
        right={<Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>}
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={STATUSES as unknown as { key: string; label: string }[]} value={status} onChange={setStatus} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No statements" body="Nothing in this filter." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const paid = item.status === 'paid';
            return (
              <Card>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[text.title, { color: p.foreground }]}>{item.chef_name ?? item.chef_id.slice(0, 8)}</Text>
                    <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                      {formatDate(item.week_start)} → {formatDate(item.week_end)} · {item.orders_count} orders
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={{ fontFamily: 'InterTight-SemiBold', fontSize: 16, color: p.foreground, fontVariant: ['tabular-nums'] }}>{formatINR(item.net_payout)}</Text>
                    <Badge label={titleCase(item.status)} tone={statusTone(item.status)} />
                  </View>
                </View>
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]}>
                  Gross {formatINR(item.gross_revenue)} · Commission {formatINR(item.platform_commission)} · GST {formatINR(item.cgst + item.sgst + item.igst)} · TDS {formatINR(item.tds)}
                </Text>
                {paid ? (
                  item.payout_ref ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>Ref: {item.payout_ref}</Text> : null
                ) : (
                  <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                    <Button label="Mark paid" variant="secondary" disabled={markPaid.isPending} onPress={() => mark(item)} />
                  </View>
                )}
              </Card>
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
git add apps/mobile/app/homechef/payouts.tsx
git commit -m "feat(mobile): homechef payouts (weekly statements + mark-paid)"
```

---

## Task 8: Hub wiring + final gate

**Files:** Modify `apps/mobile/app/homechef/index.tsx`

- [ ] **Step 1: Add the Payments group, move Payouts out of Money**

In `apps/mobile/app/homechef/index.tsx`:

(a) Add these icons to the `lucide-react-native` import (alongside existing ones — keep the ones already imported): `Landmark`, `RotateCcw`, `CreditCard`, `SlidersHorizontal`. (`BadgeIndianRupee` is already imported for Payouts.)

(b) In the `Money` group's items, **remove** the existing `Payouts` row:
```ts
    { title: 'Payouts', sub: 'Weekly chef statements', icon: BadgeIndianRupee, route: '/homechef/payouts', live: false },
```
(so the Money group keeps only Cancellations, Delivery failures, Wallets).

(c) Add a new group immediately after the `Money` group:
```ts
  { group: 'Payments', items: [
    { title: 'Payouts', sub: 'Weekly chef statements', icon: BadgeIndianRupee, route: '/homechef/payouts', live: true },
    { title: 'Payout setup', sub: 'Blocked chefs + automation', icon: SlidersHorizontal, route: '/homechef/payout-setup', live: true },
    { title: 'Payout queue', sub: 'Escrow release/withhold/reverse', icon: Landmark, route: '/homechef/payout-queue', live: true },
    { title: 'Refund payouts', sub: 'Execute meal-plan refunds', icon: RotateCcw, route: '/homechef/refund-payouts', live: true },
    { title: 'Payment gateway', sub: 'Razorpay + Stripe status', icon: CreditCard, route: '/homechef/payment-gateway', live: true },
  ]},
```

- [ ] **Step 2: Full-slice gate + commit**

```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean across the whole slice. Then:
```bash
git add apps/mobile/app/homechef/index.tsx
git commit -m "feat(mobile): homechef hub — Payments group live (5 screens)"
```

---

## Self-review (completed during authoring)

- **Spec coverage:** Payout Queue release/withhold/reverse + bulk + SLA age + open-issue gating (T3), Payout Setup blocked chefs + requirements + 3-way automation toggle (T4), Refund Payouts execute (T5), read-only Payment Gateway status (T6), Payouts statements + mark-paid (T7), data layer hc (T1) + plat (T2), hub Payments group + move Payouts (T8). Payment-gateway is read-only (no PUT). Bulk-release kept. CSV export dropped.
- **Placeholder scan:** no TBD/TODO; every step carries full code or an exact edit.
- **Type consistency:** `usePayoutAction().mutate({path, reason?})` matches T3 call sites (release omits reason → no body; withhold/reverse pass reason); `useBulkReleasePayouts().mutate(items)` where items = `{aggType,id}[]` matches T3; `useSetPayoutAutomation().mutate({chefId,value})` matches T4; `useMarkPaid().mutate({id,payoutRef})` matches T7; `useExecuteRefund().mutate(dayId)` matches T5. `PendingPayout`/`PayoutHoldStatus`/`BlockedChef`/`parseSettlementRequirements` (returns `SettlementRequirement[]|null`, items `field_reference?/reason_code?/resolution_url?`) match extraction; `PaymentGatewayStatus` has no `keySecretSet` (reuse `configured`); `StatementsResponse.pagination` = `{page,limit,total,totalPages}`; kit `Button` tone `'default'|'danger'`, `useConfirm().prompt` returns `string|null`. Money via `formatINR` everywhere, no ÷100.
- **Hub:** Payouts moves from Money → new Payments group; only Staff remains `live:false` after this slice.
