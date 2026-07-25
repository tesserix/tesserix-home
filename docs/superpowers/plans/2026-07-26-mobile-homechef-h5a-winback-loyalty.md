# Mobile HomeChef — H5 Part 1: Winback + Loyalty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the editable Winback and Loyalty config+analytics screens (H5's two self-contained config screens) and add a "Marketing" hub group (Winback + Loyalty live; Campaigns + Promos as "Soon", built in H5 Part 2).

**Architecture:** Two expo-router screens + hc-gateway hooks in `lib/hooks.ts`. Each screen = an editable config card (enabled `Switch` + numeric `TextInput`s + Save) and a read-only analytics card (kit `StatGrid`/`StatTile`). Money/rates are rupees/decimals entered raw (no ÷100), string-held in form state, `Number()`-converted on save (web pattern).

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, `@tesserix/homechef-shared`, kit `apps/mobile/components/kit.tsx`, theme `apps/mobile/lib/theme.ts`.

## Global Constraints

- No RN unit-test runner. Gate = `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, clean. Every task ends with gate + commit. No unit tests; TDD n/a.
- hc client (`lib/api.ts`): `hc.get<T>(path, params?)`, `hc.put<T>(path, body?)`. Errors → `apiError(e)`.
- Shared types (exported): `WinbackConfig` (`enabled, discountPercent, maxDiscount, validityDays, lapseThresholdDays, cooldownDays`), `WinbackAnalytics` (`total, offered, reactivated, expired, reactivationRate, byTrigger: WinbackTriggerStat[] | null`), `WinbackTriggerStat` (`trigger, total, reactivated`), `WINBACK_TRIGGER_LABEL` (`Record<string,string>`), `LoyaltyConfig` (`enabled, pointsPerRupee, redeemRate, minRedeem, streakThreshold, streakBonus, streakGraceDays, tierSilverAt, tierGoldAt`), `LoyaltyAnalytics` (`members, outstandingPts, pointsEarned, pointsRedeemed, activeStreaks, longestStreak`), `formatCount`, `formatRatioPct` (takes 0..1), `formatINR`.
- `byTrigger` is nullable — always guard `(a?.byTrigger ?? [])`. `enabled` is a toggle, edited separately from the numeric fields. Config saves are non-destructive (no confirm dialog).
- Commit: conventional, single-line, no signatures. Commit directly to `main`.

## Smoke-test harness (user's step)
Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///homechef/winback"`. Implementers gate on `tsc` only.

## File structure
- Modify `apps/mobile/lib/hooks.ts` — winback + loyalty hooks. (Task 1)
- Create `apps/mobile/app/homechef/winback.tsx`. (Task 2)
- Create `apps/mobile/app/homechef/loyalty.tsx`. (Task 3)
- Modify `apps/mobile/app/homechef/index.tsx` — add Marketing group. (Task 4)

---

## Task 1: Data-layer — winback + loyalty hooks

**Files:** Modify `apps/mobile/lib/hooks.ts`
**Interfaces:** Produces `useWinbackConfig`, `useWinbackAnalytics`, `useSaveWinback`, `useLoyaltyConfig`, `useLoyaltyAnalytics`, `useSaveLoyalty`; `qk` keys `winbackConfig`, `winbackAnalytics`, `loyaltyConfig`, `loyaltyAnalytics`.

- [ ] **Step 1: Extend the shared type import**

Add to the `@tesserix/homechef-shared` type import block in `apps/mobile/lib/hooks.ts`:
```ts
  WinbackConfig,
  WinbackAnalytics,
  LoyaltyConfig,
  LoyaltyAnalytics,
```

- [ ] **Step 2: Add qk keys + hooks**

Add to the `qk` object:
```ts
  winbackConfig: ['hc', 'winback-config'] as const,
  winbackAnalytics: ['hc', 'winback-analytics'] as const,
  loyaltyConfig: ['hc', 'loyalty-config'] as const,
  loyaltyAnalytics: ['hc', 'loyalty-analytics'] as const,
```
Append to end of file:
```ts
// ---- Winback + Loyalty config/analytics -------------------------------------
export const useWinbackConfig = () =>
  useQuery({ queryKey: qk.winbackConfig, queryFn: () => hc.get<WinbackConfig>('/winback/config') });
export const useWinbackAnalytics = () =>
  useQuery({ queryKey: qk.winbackAnalytics, queryFn: () => hc.get<WinbackAnalytics>('/winback/analytics') });
export function useSaveWinback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: WinbackConfig) => hc.put('/winback/config', c),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.winbackConfig }),
  });
}

export const useLoyaltyConfig = () =>
  useQuery({ queryKey: qk.loyaltyConfig, queryFn: () => hc.get<LoyaltyConfig>('/loyalty/config') });
export const useLoyaltyAnalytics = () =>
  useQuery({ queryKey: qk.loyaltyAnalytics, queryFn: () => hc.get<LoyaltyAnalytics>('/loyalty/analytics') });
export function useSaveLoyalty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: LoyaltyConfig) => hc.put('/loyalty/config', c),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.loyaltyConfig }),
  });
}
```

- [ ] **Step 3: Gate + commit**
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Then: `git add apps/mobile/lib/hooks.ts && git commit -m "feat(mobile): hc hooks for homechef winback + loyalty config/analytics"`

---

## Task 2: Winback screen

**Files:** Create `apps/mobile/app/homechef/winback.tsx`
**Interfaces:** Consumes `useWinbackConfig`/`useWinbackAnalytics`/`useSaveWinback` (`lib/hooks`); `WINBACK_TRIGGER_LABEL`/`formatCount`/`formatRatioPct`/`WinbackConfig` (shared); `apiError`; kit.

- [ ] **Step 1: Create the Winback screen**

Create `apps/mobile/app/homechef/winback.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useWinbackConfig, useWinbackAnalytics, useSaveWinback } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { WINBACK_TRIGGER_LABEL, formatCount, formatRatioPct, type WinbackConfig } from '@tesserix/homechef-shared';
import { Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const FIELDS: { key: keyof WinbackConfig; label: string }[] = [
  { key: 'discountPercent', label: 'Discount %' },
  { key: 'maxDiscount', label: 'Max discount (₹)' },
  { key: 'validityDays', label: 'Valid for (days)' },
  { key: 'lapseThresholdDays', label: 'Lapse after (days)' },
  { key: 'cooldownDays', label: 'Cooldown (days)' },
];

export default function Winback() {
  const p = usePalette();
  const cfg = useWinbackConfig();
  const analytics = useWinbackAnalytics();
  const save = useSaveWinback();
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const d = cfg.data;
    if (d) {
      setEnabled(d.enabled);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(d[f.key])])));
    }
  }, [cfg.data]);

  function onSave() {
    const body: WinbackConfig = {
      enabled,
      discountPercent: Number(form.discountPercent),
      maxDiscount: Number(form.maxDiscount),
      validityDays: Number(form.validityDays),
      lapseThresholdDays: Number(form.lapseThresholdDays),
      cooldownDays: Number(form.cooldownDays),
    };
    setNotice(null);
    save.mutate(body, { onSuccess: () => setNotice('Saved.'), onError: (e) => Alert.alert('Save failed', apiError(e)) });
  }

  const a = analytics.data;
  const back = <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>;

  return (
    <Screen>
      <ScreenHeader title="Win-back" subtitle="Auto reactivation offers" right={back} />
      {cfg.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={cfg.isRefetching || analytics.isRefetching} onRefresh={() => { cfg.refetch(); analytics.refetch(); }} />}
        >
          {notice ? <Banner text={notice} tone="success" /> : null}
          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Configuration</SectionLabel>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[text.title, { color: p.foreground }]}>Enabled</Text>
                <Switch value={enabled} onValueChange={setEnabled} />
              </View>
              {FIELDS.map((f) => (
                <View key={f.key} style={{ marginTop: 10 }}>
                  <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{f.label}</Text>
                  <TextInput
                    value={form[f.key] ?? ''}
                    onChangeText={(t) => setForm((s) => ({ ...s, [f.key]: t }))}
                    keyboardType="numeric"
                    placeholderTextColor={p.mutedForeground}
                    style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
                  />
                </View>
              ))}
              <View style={{ marginTop: 14 }}>
                <Button label={save.isPending ? 'Saving…' : 'Save'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
              </View>
            </Card>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Analytics</SectionLabel></View>
          <StatGrid>
            <StatTile label="Offered" value={formatCount(a?.offered)} />
            <StatTile label="Reactivated" value={formatCount(a?.reactivated)} tone="success" />
            <StatTile label="Expired" value={formatCount(a?.expired)} />
            <StatTile label="Reactivation" value={a ? formatRatioPct(a.reactivationRate) : '—'} />
          </StatGrid>
          {(a?.byTrigger ?? []).length > 0 ? (
            <View style={{ paddingHorizontal: space[4] }}>
              <Card>
                <View style={{ gap: 8 }}>
                  {(a?.byTrigger ?? []).map((t) => (
                    <View key={t.trigger} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={[text.body, { color: p.foreground }]}>{WINBACK_TRIGGER_LABEL[t.trigger] ?? t.trigger}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground }]}>{formatCount(t.reactivated)} / {formatCount(t.total)}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            </View>
          ) : null}
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
Then: `git add apps/mobile/app/homechef/winback.tsx && git commit -m "feat(mobile): homechef win-back (editable config + analytics)"`

---

## Task 3: Loyalty screen

**Files:** Create `apps/mobile/app/homechef/loyalty.tsx`
**Interfaces:** Consumes `useLoyaltyConfig`/`useLoyaltyAnalytics`/`useSaveLoyalty` (`lib/hooks`); `formatCount`/`LoyaltyConfig` (shared); `apiError`; kit.

- [ ] **Step 1: Create the Loyalty screen**

Create `apps/mobile/app/homechef/loyalty.tsx` (same structure as winback; 8 numeric fields, 6 analytics tiles, no by-trigger):
```tsx
import { useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useLoyaltyConfig, useLoyaltyAnalytics, useSaveLoyalty } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { formatCount, type LoyaltyConfig } from '@tesserix/homechef-shared';
import { Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, StatGrid, StatTile } from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

const FIELDS: { key: keyof LoyaltyConfig; label: string }[] = [
  { key: 'pointsPerRupee', label: 'Points per ₹' },
  { key: 'redeemRate', label: '₹ per point' },
  { key: 'minRedeem', label: 'Min redeem (points)' },
  { key: 'streakThreshold', label: 'Streak threshold' },
  { key: 'streakBonus', label: 'Streak bonus (points)' },
  { key: 'streakGraceDays', label: 'Streak grace (days)' },
  { key: 'tierSilverAt', label: 'Silver at (points)' },
  { key: 'tierGoldAt', label: 'Gold at (points)' },
];

export default function Loyalty() {
  const p = usePalette();
  const cfg = useLoyaltyConfig();
  const analytics = useLoyaltyAnalytics();
  const save = useSaveLoyalty();
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const d = cfg.data;
    if (d) {
      setEnabled(d.enabled);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(d[f.key])])));
    }
  }, [cfg.data]);

  function onSave() {
    const body: LoyaltyConfig = {
      enabled,
      pointsPerRupee: Number(form.pointsPerRupee),
      redeemRate: Number(form.redeemRate),
      minRedeem: Number(form.minRedeem),
      streakThreshold: Number(form.streakThreshold),
      streakBonus: Number(form.streakBonus),
      streakGraceDays: Number(form.streakGraceDays),
      tierSilverAt: Number(form.tierSilverAt),
      tierGoldAt: Number(form.tierGoldAt),
    };
    setNotice(null);
    save.mutate(body, { onSuccess: () => setNotice('Saved.'), onError: (e) => Alert.alert('Save failed', apiError(e)) });
  }

  const a = analytics.data;
  const back = <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}><ChevronLeft size={24} color={p.mutedForeground} /></Pressable>;

  return (
    <Screen>
      <ScreenHeader title="Loyalty" subtitle="Points programme" right={back} />
      {cfg.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={cfg.isRefetching || analytics.isRefetching} onRefresh={() => { cfg.refetch(); analytics.refetch(); }} />}
        >
          {notice ? <Banner text={notice} tone="success" /> : null}
          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Configuration</SectionLabel>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[text.title, { color: p.foreground }]}>Enabled</Text>
                <Switch value={enabled} onValueChange={setEnabled} />
              </View>
              {FIELDS.map((f) => (
                <View key={f.key} style={{ marginTop: 10 }}>
                  <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{f.label}</Text>
                  <TextInput
                    value={form[f.key] ?? ''}
                    onChangeText={(t) => setForm((s) => ({ ...s, [f.key]: t }))}
                    keyboardType="numeric"
                    placeholderTextColor={p.mutedForeground}
                    style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
                  />
                </View>
              ))}
              <View style={{ marginTop: 14 }}>
                <Button label={save.isPending ? 'Saving…' : 'Save'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
              </View>
            </Card>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Analytics</SectionLabel></View>
          <StatGrid>
            <StatTile label="Members" value={formatCount(a?.members)} />
            <StatTile label="Outstanding pts" value={formatCount(a?.outstandingPts)} tone="warning" />
            <StatTile label="Earned" value={formatCount(a?.pointsEarned)} />
            <StatTile label="Redeemed" value={formatCount(a?.pointsRedeemed)} />
            <StatTile label="Active streaks" value={formatCount(a?.activeStreaks)} />
            <StatTile label="Longest streak" value={formatCount(a?.longestStreak)} />
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
Then: `git add apps/mobile/app/homechef/loyalty.tsx && git commit -m "feat(mobile): homechef loyalty (editable config + analytics)"`

---

## Task 4: Hub wiring (Marketing group)

**Files:** Modify `apps/mobile/app/homechef/index.tsx`

- [ ] **Step 1: Add the Marketing group**

(a) Add these icons to the `lucide-react-native` import (keep existing): `Megaphone`, `Gift`, `Sparkles`, `TicketPercent`.

(b) Add a new group immediately after the `Payments` group (Campaigns + Promos are `live:false` — they ship in H5 Part 2; Win-back + Loyalty are `live:true`):
```ts
  { group: 'Marketing', items: [
    { title: 'Campaigns', sub: 'Push/email blasts', icon: Megaphone, route: '/homechef/campaigns', live: false },
    { title: 'Win-back', sub: 'Auto reactivation offers', icon: Gift, route: '/homechef/winback', live: true },
    { title: 'Loyalty', sub: 'Points programme', icon: Sparkles, route: '/homechef/loyalty', live: true },
    { title: 'Promos', sub: 'Discount codes', icon: TicketPercent, route: '/homechef/promos', live: false },
  ]},
```

- [ ] **Step 2: Full gate + commit**
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Then: `git add apps/mobile/app/homechef/index.tsx && git commit -m "feat(mobile): homechef hub — Marketing group (Win-back + Loyalty live)"`

---

## Self-review (completed during authoring)
- **Coverage:** hooks (T1), editable Winback config+analytics with by-trigger guard (T2), editable Loyalty config+analytics (T3), hub Marketing group (T4). Campaigns/Promos deferred to H5 Part 2 (hub rows added as Soon now).
- **Placeholders:** none.
- **Type consistency:** `useSaveWinback/Loyalty` take the full typed config; forms hold strings seeded via `useEffect` from config, `Number()`-converted on save; `formatRatioPct` (0..1) for reactivationRate; `byTrigger` guarded `(a?.byTrigger ?? [])`. `Switch` from react-native. Money/rates raw (no ÷100).
