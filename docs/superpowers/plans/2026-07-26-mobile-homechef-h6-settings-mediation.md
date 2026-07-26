# Mobile HomeChef H6 — Settings & Mediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port HomeChef's four remaining admin areas to the Expo app at full parity — editable Platform Settings (policy / subscription pricing / referral), Staff (list + invitations + activate/deactivate), read-only Audit Log, and Mediation (message inbox + relay + block) — then wire the hub so the HomeChef hub has no `live:false` rows left.

**Architecture:** Four new `hc`-gateway screen routes under `apps/mobile/app/homechef/`, backed by new TanStack Query hooks in `lib/hooks.ts`. The three Platform Settings config cards live in a co-located non-route component file (`components/homechef/settings-sections.tsx`); route files under `app/` become expo-router routes, so form components live outside `app/`. Money is rupees throughout (no ÷100). Destructive/money actions route through the existing `useConfirm` PromptSheet.

**Tech Stack:** Expo / expo-router, React 19, TanStack Query v5, axios via the `hc` client (`apps/mobile/lib/api.ts`), shared wire types from `@tesserix/homechef-shared`, kit vocabulary (`apps/mobile/components/kit.tsx`), `useConfirm` (`apps/mobile/components/prompt.tsx`).

## Global Constraints

- **No RN unit-test runner.** The test cycle for every task is the typecheck gate: `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, expecting **0 errors**. Rebuild the shared package first or tsc reports stale-dist missing exports. Keep files free of unused imports.
- **Money is rupees** — raw numbers, no ÷100. Settings forms render money fields as raw editable numbers (the `₹` sits in the label text, NOT via `formatINR`).
- **Form numeric fields are string-held**, `Number()`-converted on submit.
- **Mobile hc verbs:** `hc.get/post/put/del` (delete is `del`, not `delete`).
- **Config PUTs send the COMPLETE typed object** (no partial-PUT wipe — same discipline as winback/loyalty).
- **`operatingDays: number[] | null`** — `[]` or `null` means "OPEN EVERY DAY", NOT closed. Coalesce `null → []` once at load; show "None selected — open every day." when zero days are selected; never coerce empty → closed.
- **Confirm-gating (resolved):** Platform Settings — **Policy and Subscription Pricing saves are confirm-gated; Referral saves directly.** Staff — revoke + deactivate + reactivate confirm-gated; **resend-invite is NOT confirmed.** Mediation — **relay AND block are ALWAYS confirm-gated** (deviates from web's PII-only relay confirm).
- **Staff reactivate endpoint is `PUT /staff/:id/reactivate`** (NOT `/activate`). Deactivate is `PUT /staff/:id/deactivate`.
- **`StaffMember` shared type is mis-shaped** (nested `user`); mobile declares a local flat `StaffRow` and stops using the shared type for staff.
- **Audit Log returns a FLAT `{ logs, total, page, limit }` envelope** (key is `logs`, not `data`; NOT `Paginated<T>`). `AuditLogEntry`/`AuditLogResponse`/`AuditUser` are shared — reuse.
- **Mediation types** (`MediatedMessage`/`MediationRole`/`RelayStatus`/`MEDIATION_ROLE_LABEL`) are shared — reuse. Inbox polls every **20s**.
- Commit directly on `main`, single-line conventional-commit messages, no signature/body.

---

## File Structure

- **Modify** `apps/mobile/lib/hooks.ts` — Task 1 adds settings `qk` keys + 6 settings hooks; Task 2 adds staff/audit/mediation `qk` keys + hooks, local `StaffRow`/`StaffInvitation` types, and re-types the existing `useStaff`.
- **Create** `apps/mobile/components/homechef/settings-sections.tsx` — `PolicyCard`, `PricingCard`, `ReferralCard` (Task 3).
- **Create** `apps/mobile/app/homechef/platform-settings.tsx` — route stacking the three cards (Task 3).
- **Create** `apps/mobile/app/homechef/staff.tsx` — route (Task 4).
- **Create** `apps/mobile/app/homechef/audit-log.tsx` — route (Task 5).
- **Create** `apps/mobile/app/homechef/mediation.tsx` — route (Task 6).
- **Modify** `apps/mobile/app/homechef/index.tsx` — new "Settings & mediation" group + flip Staff row live (Task 7).

---

## Task 1: Platform Settings hooks

**Files:**
- Modify: `apps/mobile/lib/hooks.ts`

**Interfaces:**
- Consumes: `hc` client; shared `PlatformPolicy`, `SubscriptionPricing`, `ReferralConfig`.
- Produces: `usePlatformPolicy`, `useSavePlatformPolicy`, `useSubscriptionPricing`, `useSaveSubscriptionPricing`, `useReferralConfig`, `useSaveReferralConfig`.

- [ ] **Step 1: Add shared-type imports**

Extend the existing `@tesserix/homechef-shared` import block in `hooks.ts` with:

```ts
  PlatformPolicy,
  SubscriptionPricing,
  ReferralConfig,
```

- [ ] **Step 2: Add `qk` keys**

In the `qk` object, add:

```ts
  platformPolicy: ['hc', 'platform-policy'] as const,
  subscriptionPricing: ['hc', 'subscription-pricing'] as const,
  referralConfig: ['hc', 'referral-config'] as const,
```

- [ ] **Step 3: Append the settings hooks at the end of the file**

```ts
// ---- Platform Settings: policy / subscription pricing / referral -----------
// Each save PUTs the COMPLETE typed object (no partial-PUT wipe) and invalidates
// only its own query. Money is rupees throughout (no ÷100).
export const usePlatformPolicy = () =>
  useQuery({ queryKey: qk.platformPolicy, queryFn: () => hc.get<PlatformPolicy>('/platform/policy') });
export function useSavePlatformPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: PlatformPolicy) => hc.put('/platform/policy', c),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.platformPolicy }),
  });
}

export const useSubscriptionPricing = () =>
  useQuery({ queryKey: qk.subscriptionPricing, queryFn: () => hc.get<SubscriptionPricing>('/subscription-pricing') });
export function useSaveSubscriptionPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: SubscriptionPricing) => hc.put('/subscription-pricing', c),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.subscriptionPricing }),
  });
}

export const useReferralConfig = () =>
  useQuery({ queryKey: qk.referralConfig, queryFn: () => hc.get<ReferralConfig>('/referral/config') });
export function useSaveReferralConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: ReferralConfig) => hc.put('/referral/config', c),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.referralConfig }),
  });
}
```

- [ ] **Step 4: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): hc hooks for homechef platform settings (policy/pricing/referral)"
```

---

## Task 2: Staff + Audit + Mediation hooks + local types

**Files:**
- Modify: `apps/mobile/lib/hooks.ts`

**Interfaces:**
- Consumes: `hc`; shared `Paginated`, `AuditLogResponse`, `MediatedMessage`; the currently-imported shared `StaffMember` (to be removed).
- Produces: local `StaffRow`, `StaffInvitation`; re-typed `useStaff`; `useStaffInvitations`, `useInviteStaff`, `useStaffInvitationAction`, `useSetStaffActive`; `useAuditLogs`; `useMediationInbox`, `useMediationAction`.

- [ ] **Step 1: Add shared-type imports, remove the mis-shaped `StaffMember`**

In the `@tesserix/homechef-shared` import block: **remove** `StaffMember` (it is only used by `useStaff`, which this task re-types), and **add**:

```ts
  AuditLogResponse,
  MediatedMessage,
```

(`Paginated` is already imported.)

- [ ] **Step 2: Add the local flat staff types near the other local types (after `PendingRefundDay`)**

```ts
// The Go StaffMemberResponse is FLAT — email/name/joinedAt at the top level, not
// nested under `user`. The shared StaffMember is mis-shaped (nested user + createdAt);
// declare the real wire shape locally, matching the web page's page-local override.
export interface StaffRow {
  id: string;
  userId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  staffRole: string;
  department?: string;
  title?: string;
  isActive: boolean;
  permissions?: string[];
  lastActiveAt?: string;
  joinedAt?: string;
}

export interface StaffInvitation {
  id: string;
  email: string;
  staffRole: string;
  status: string;
  createdAt: string;
}
```

- [ ] **Step 3: Add `qk` keys**

```ts
  staffInvitations: (p: object) => ['hc', 'staff-invitations', p] as const,
  auditLogs: (p: object) => ['hc', 'audit-logs', p] as const,
  mediationInbox: ['hc', 'mediation-inbox'] as const,
```

(`qk.staff` already exists.)

- [ ] **Step 4: Re-type the existing `useStaff`**

Find the existing `useStaff` (typed `Paginated<StaffMember>`) and change its response type to the local flat `StaffRow`:

```ts
export const useStaff = (p: { page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.staff(p), queryFn: () => hc.get<Paginated<StaffRow>>('/staff', p) });
```

- [ ] **Step 5: Append the staff / audit / mediation hooks at the end of the file**

```ts
// ---- Staff: invitations + activate/deactivate ------------------------------
export const useStaffInvitations = (p: { page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.staffInvitations(p), queryFn: () => hc.get<Paginated<StaffInvitation>>('/staff/invitations', p) });

export function useInviteStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { email: string; staffRole: string }) => hc.post('/staff/invitations', a),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'staff-invitations'] }),
  });
}

// revoke | resend → PUT /staff/invitations/:id/:action (no body).
export function useStaffInvitationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; action: 'revoke' | 'resend' }) => hc.put(`/staff/invitations/${a.id}/${a.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'staff-invitations'] }),
  });
}

// deactivate | reactivate → PUT /staff/:id/:action (no body). NOTE: bring-back is
// `/reactivate`, NOT `/activate`.
export function useSetStaffActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; action: 'deactivate' | 'reactivate' }) => hc.put(`/staff/${a.id}/${a.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'staff'] }),
  });
}

// ---- Audit Log (read-only) -------------------------------------------------
// FLAT envelope { logs, total, page, limit } — NOT Paginated<T>. Filters are free
// text; only non-empty ones are sent.
export const useAuditLogs = (p: { action?: string; entityType?: string; from?: string; to?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.auditLogs(p), queryFn: () => hc.get<AuditLogResponse>('/audit-logs', p) });

// ---- Mediation: inbox + relay/block ----------------------------------------
export const useMediationInbox = () =>
  useQuery({
    queryKey: qk.mediationInbox,
    queryFn: () => hc.get<{ data: MediatedMessage[] }>('/messages/inbox'),
    refetchInterval: 20_000,
  });

// relay | block → POST /messages/:id/:action (no body).
export function useMediationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; action: 'relay' | 'block' }) => hc.post(`/messages/${a.id}/${a.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mediationInbox }),
  });
}
```

- [ ] **Step 6: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors. (If any other file still imports the shared `StaffMember` via `hooks.ts`, tsc will flag it — none does; the only consumer was `useStaff`.)

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): hc hooks for homechef staff/audit/mediation (+ local flat StaffRow)"
```

---

## Task 3: Platform Settings screen (3 editable config cards)

**Files:**
- Create: `apps/mobile/components/homechef/settings-sections.tsx`
- Create: `apps/mobile/app/homechef/platform-settings.tsx`

**Interfaces:**
- Consumes: settings hooks (Task 1); `useConfirm` (`../prompt`); kit `Banner`, `Button`, `Card`, `Switch`(RN), `FilterChips`(not needed here); theme; shared `PlatformPolicy`, `SubscriptionPricing`, `ReferralConfig`.
- Produces: `PolicyCard`, `PricingCard`, `ReferralCard` (each `() => JSX`); default-exported route `PlatformSettings`.

- [ ] **Step 1: Create `settings-sections.tsx` with a shared `NumberField` + text/switch helpers and `PolicyCard`**

```tsx
// settings-sections.tsx — HomeChef platform-settings config cards. Route files
// live under app/, so these editable cards live here (outside app/). Each card
// loads its config, edits a string-held form, and PUTs the complete typed object.
// Money is rupees (₹ in the label, no formatINR, no ÷100).
import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import type { PlatformPolicy, ReferralConfig, SubscriptionPricing } from '@tesserix/homechef-shared';
import { Banner, Button, Card } from '../kit';
import {
  usePlatformPolicy, useSavePlatformPolicy,
  useSubscriptionPricing, useSaveSubscriptionPricing,
  useReferralConfig, useSaveReferralConfig,
} from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../prompt';
import { usePalette, radius, space, text } from '../../lib/theme';

// 0=Sunday..6=Saturday — index IS the value stored in operatingDays (matches Go's
// time.Weekday()). Do not reorder: Monday-first would shift every day by one.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function LabeledInput({ label, value, onChangeText, numeric, hint }: { label: string; value: string; onChangeText: (t: string) => void; numeric?: boolean; hint?: string }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={p.mutedForeground}
        style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
      />
      {hint ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>{hint}</Text> : null}
    </View>
  );
}

function SavedNotice({ notice }: { notice: { ok: boolean; text: string } | null }) {
  if (!notice) return null;
  return <View style={{ marginTop: 12 }}><Banner text={notice.text} tone={notice.ok ? 'success' : 'danger'} /></View>;
}

export function PolicyCard() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const q = usePlatformPolicy();
  const save = useSavePlatformPolicy();
  const [form, setForm] = useState<PlatformPolicy | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [num, setNum] = useState<Record<string, string>>({});

  // Coalesce the nil-slice operatingDays to [] ONCE at load; a null .includes() crashes.
  useEffect(() => {
    const d = q.data;
    if (d) {
      setForm({ ...d, operatingDays: d.operatingDays ?? [] });
      setNum({
        serviceFeePercent: String(d.serviceFeePercent),
        taxPercent: String(d.taxPercent),
        chefPayoutPercent: String(d.chefPayoutPercent),
        driverPayoutPercent: String(d.driverPayoutPercent),
        baseDeliveryFee: String(d.baseDeliveryFee),
        perKmDeliveryFee: String(d.perKmDeliveryFee),
      });
    }
  }, [q.data]);

  if (!form) return null;
  const days = form.operatingDays ?? [];

  function toggleDay(idx: number) {
    setForm((f) => {
      if (!f) return f;
      const cur = f.operatingDays ?? [];
      const next = cur.includes(idx) ? cur.filter((d) => d !== idx) : [...cur, idx].sort((a, b) => a - b);
      return { ...f, operatingDays: next };
    });
  }

  async function onSave() {
    if (!form) return;
    const body: PlatformPolicy = {
      ...form,
      serviceFeePercent: Number(num.serviceFeePercent),
      taxPercent: Number(num.taxPercent),
      chefPayoutPercent: Number(num.chefPayoutPercent),
      driverPayoutPercent: Number(num.driverPayoutPercent),
      baseDeliveryFee: Number(num.baseDeliveryFee),
      perKmDeliveryFee: Number(num.perKmDeliveryFee),
    };
    const ok = await confirm({
      title: 'Save platform policy?',
      message: `Service fee ${body.serviceFeePercent}% and chef payout ${body.chefPayoutPercent}% apply to every new order from the moment you save.`,
      confirmLabel: 'Save policy',
    });
    if (!ok) return;
    setNotice(null);
    save.mutate(body, {
      onSuccess: () => setNotice({ ok: true, text: 'Policy saved.' }),
      onError: (e) => setNotice({ ok: false, text: apiError(e) }),
    });
  }

  return (
    <Card>
      <Text style={[text.title, { color: p.foreground }]}>Fees & payouts</Text>
      <LabeledInput label="Service fee %" value={num.serviceFeePercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, serviceFeePercent: t }))} numeric hint="Platform's cut, charged to the customer." />
      <LabeledInput label="Tax %" value={num.taxPercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, taxPercent: t }))} numeric />
      <LabeledInput label="Chef payout %" value={num.chefPayoutPercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, chefPayoutPercent: t }))} numeric hint="Share of the order that reaches the chef." />
      <LabeledInput label="Driver payout %" value={num.driverPayoutPercent ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, driverPayoutPercent: t }))} numeric />
      <LabeledInput label="Base delivery fee ₹" value={num.baseDeliveryFee ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, baseDeliveryFee: t }))} numeric />
      <LabeledInput label="Per-km delivery fee ₹" value={num.perKmDeliveryFee ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, perKmDeliveryFee: t }))} numeric />
      <LabeledInput label="Opens (HH:MM)" value={form.openingTime} onChangeText={(t) => setForm((f) => (f ? { ...f, openingTime: t } : f))} />
      <LabeledInput label="Closes (HH:MM)" value={form.closingTime} onChangeText={(t) => setForm((f) => (f ? { ...f, closingTime: t } : f))} />
      <LabeledInput label="Timezone" value={form.timezone} onChangeText={(t) => setForm((f) => (f ? { ...f, timezone: t } : f))} />

      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12, marginBottom: 6 }]}>Operating days</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {WEEKDAYS.map((d, i) => {
          const on = days.includes(i);
          return (
            <Pressable
              key={d}
              onPress={() => toggleDay(i)}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: on ? p.primary : p.border, backgroundColor: on ? p.primary : 'transparent' }}
            >
              <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 13, color: on ? p.primaryForeground : p.mutedForeground }}>{d}</Text>
            </Pressable>
          );
        })}
      </View>
      {days.length === 0 ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>None selected — open every day.</Text>
      ) : null}

      <LabeledInput label="Closed message" value={form.closedMessage} onChangeText={(t) => setForm((f) => (f ? { ...f, closedMessage: t } : f))} hint="What customers see outside trading hours." />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <Text style={[text.body, { color: p.foreground, flex: 1, paddingRight: 12 }]}>Auto-confirm delivery</Text>
        <Switch value={form.confirmReceiptFlowEnabled ?? true} onValueChange={(v) => setForm((f) => (f ? { ...f, confirmReceiptFlowEnabled: v } : f))} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>After delivery, remind the customer to confirm receipt; if they never respond it auto-confirms so the chef's payout can proceed. Off = manual confirmation only.</Text>

      <View style={{ marginTop: 16 }}>
        <Button label={save.isPending ? 'Saving…' : 'Save policy'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
      </View>
      <SavedNotice notice={notice} />
    </Card>
  );
}
```

- [ ] **Step 2: Add `PricingCard` (nested tiers; confirm-gated) to the same file**

```tsx
const TIERS = ['standard', 'premium'] as const;
const PERIODS = ['monthly', 'quarterly', 'yearly'] as const;

export function PricingCard() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const q = useSubscriptionPricing();
  const save = useSaveSubscriptionPricing();
  const [form, setForm] = useState<SubscriptionPricing | null>(null);
  const [num, setNum] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const d = q.data;
    if (d) {
      setForm(d);
      setNum({
        trialDays: String(d.trialDays),
        minEarningsThreshold: String(d.minEarningsThreshold),
        premiumCommissionRate: String(d.premiumCommissionRate),
        standard_monthly: String(d.standard.monthly),
        standard_quarterly: String(d.standard.quarterly),
        standard_yearly: String(d.standard.yearly),
        premium_monthly: String(d.premium.monthly),
        premium_quarterly: String(d.premium.quarterly),
        premium_yearly: String(d.premium.yearly),
      });
    }
  }, [q.data]);

  if (!form) return null;

  async function onSave() {
    if (!form) return;
    const body: SubscriptionPricing = {
      ...form, // keeps country/currency pass-through (not edited on this screen)
      trialDays: Number(num.trialDays),
      minEarningsThreshold: Number(num.minEarningsThreshold),
      premiumCommissionRate: Number(num.premiumCommissionRate),
      standard: { monthly: Number(num.standard_monthly), quarterly: Number(num.standard_quarterly), yearly: Number(num.standard_yearly) },
      premium: { monthly: Number(num.premium_monthly), quarterly: Number(num.premium_quarterly), yearly: Number(num.premium_yearly) },
    };
    const ok = await confirm({
      title: 'Save subscription pricing?',
      message: 'New prices apply to every new subscription from the moment you save.',
      confirmLabel: 'Save pricing',
    });
    if (!ok) return;
    setNotice(null);
    save.mutate(body, {
      onSuccess: () => setNotice({ ok: true, text: 'Pricing saved.' }),
      onError: (e) => setNotice({ ok: false, text: apiError(e) }),
    });
  }

  return (
    <Card>
      <Text style={[text.title, { color: p.foreground }]}>Subscription pricing</Text>
      <LabeledInput label="Trial days" value={num.trialDays ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, trialDays: t }))} numeric />
      <LabeledInput label="Min earnings before billing ₹" value={num.minEarningsThreshold ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, minEarningsThreshold: t }))} numeric hint="A chef under this isn't charged." />
      <LabeledInput label="Premium commission rate %" value={num.premiumCommissionRate ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, premiumCommissionRate: t }))} numeric />
      {TIERS.map((tier) => (
        <View key={tier} style={{ marginTop: 12 }}>
          <Text style={[text.caption, { color: p.mutedForeground, textTransform: 'capitalize' }]}>{tier}</Text>
          {PERIODS.map((period) => (
            <LabeledInput
              key={period}
              label={`${period} ₹`}
              value={num[`${tier}_${period}`] ?? ''}
              onChangeText={(t) => setNum((s) => ({ ...s, [`${tier}_${period}`]: t }))}
              numeric
            />
          ))}
        </View>
      ))}
      <View style={{ marginTop: 16 }}>
        <Button label={save.isPending ? 'Saving…' : 'Save pricing'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
      </View>
      <SavedNotice notice={notice} />
    </Card>
  );
}
```

- [ ] **Step 3: Add `ReferralCard` (no confirm) to the same file**

```tsx
export function ReferralCard() {
  const p = usePalette();
  const q = useReferralConfig();
  const save = useSaveReferralConfig();
  const [form, setForm] = useState<ReferralConfig | null>(null);
  const [num, setNum] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const d = q.data;
    if (d) {
      setForm(d);
      setNum({ referrerReward: String(d.referrerReward), refereeReward: String(d.refereeReward), monthlySpendCap: String(d.monthlySpendCap) });
    }
  }, [q.data]);

  if (!form) return null;

  function onSave() {
    if (!form) return;
    const body: ReferralConfig = {
      enabled: form.enabled,
      referrerReward: Number(num.referrerReward),
      refereeReward: Number(num.refereeReward),
      monthlySpendCap: Number(num.monthlySpendCap),
    };
    setNotice(null);
    save.mutate(body, {
      onSuccess: () => setNotice({ ok: true, text: 'Referral config saved.' }),
      onError: (e) => setNotice({ ok: false, text: apiError(e) }),
    });
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[text.title, { color: p.foreground }]}>Referrals</Text>
        <Switch value={form.enabled} onValueChange={(v) => setForm((f) => (f ? { ...f, enabled: v } : f))} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>Both rewards are paid by the platform, so the monthly cap is the real exposure control.</Text>
      <LabeledInput label="Referrer reward ₹" value={num.referrerReward ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, referrerReward: t }))} numeric />
      <LabeledInput label="Referee reward ₹" value={num.refereeReward ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, refereeReward: t }))} numeric />
      <LabeledInput label="Monthly spend cap ₹" value={num.monthlySpendCap ?? ''} onChangeText={(t) => setNum((s) => ({ ...s, monthlySpendCap: t }))} numeric hint="Total the programme may pay out in a month." />
      <View style={{ marginTop: 16 }}>
        <Button label={save.isPending ? 'Saving…' : 'Save'} onPress={onSave} loading={save.isPending} disabled={save.isPending} />
      </View>
      <SavedNotice notice={notice} />
    </Card>
  );
}
```

- [ ] **Step 4: Create the route `apps/mobile/app/homechef/platform-settings.tsx`**

```tsx
// platform-settings.tsx — HomeChef platform config: fees/payouts, subscription
// pricing, referrals. Three independently-saved editable cards.
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { BackButton, LoadingRows, Screen, ScreenHeader } from '../../components/kit';
import { PolicyCard, PricingCard, ReferralCard } from '../../components/homechef/settings-sections';
import { usePlatformPolicy, useSubscriptionPricing, useReferralConfig } from '../../lib/hooks';
import { space } from '../../lib/theme';

export default function PlatformSettings() {
  const policy = usePlatformPolicy();
  const pricing = useSubscriptionPricing();
  const referral = useReferralConfig();
  const loading = policy.isLoading || pricing.isLoading || referral.isLoading;
  const refetchAll = () => { policy.refetch(); pricing.refetch(); referral.refetch(); };

  return (
    <Screen>
      <ScreenHeader title="Platform settings" subtitle="Fees, pricing & referrals" right={<BackButton onPress={() => router.back()} />} />
      {loading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={policy.isRefetching || pricing.isRefetching || referral.isRefetching} onRefresh={refetchAll} />}
        >
          <PolicyCard />
          <PricingCard />
          <ReferralCard />
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 5: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/components/homechef/settings-sections.tsx apps/mobile/app/homechef/platform-settings.tsx
git commit -m "feat(mobile): homechef platform settings screen (policy/pricing/referral, confirm-gated)"
```

---

## Task 4: Staff screen (list + invitations + invite + activate/deactivate)

**Files:**
- Create: `apps/mobile/app/homechef/staff.tsx`

**Interfaces:**
- Consumes: `useStaff`, `useStaffInvitations`, `useInviteStaff`, `useStaffInvitationAction`, `useSetStaffActive`, `StaffRow`, `StaffInvitation` (Task 2); `useConfirm`; kit `Screen`, `ScreenHeader`, `BackButton`, `Card`, `Button`, `Badge`, `Banner`, `SectionLabel`, `FilterChips`, `LoadingRows`, `EmptyState`; theme; `formatDate`, `titleCase` from shared.
- Produces: default-exported route `Staff`.

- [ ] **Step 1: Create the screen with the invite form + role picker**

```tsx
// staff.tsx — HomeChef internal team: staff list (deactivate/reactivate),
// pending invitations (revoke/resend), and an invite form. hc gateway.
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { formatDate, titleCase } from '@tesserix/homechef-shared';
import {
  Badge, BackButton, Banner, Button, Card, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, SectionLabel,
} from '../../components/kit';
import { useInviteStaff, useSetStaffActive, useStaff, useStaffInvitations, useStaffInvitationAction, type StaffRow, type StaffInvitation } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, radius, space, text } from '../../lib/theme';

const ROLES = ['support', 'fleet_manager', 'delivery_ops', 'admin', 'super_admin'];
const ROLE_OPTIONS = ROLES.map((r) => ({ key: r, label: titleCase(r) }));

function staffName(m: StaffRow): string {
  return m.email || `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.id.slice(0, 8);
}

export default function Staff() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const staff = useStaff({ page: 1, limit: 50 });
  const invitesQ = useStaffInvitations({ page: 1, limit: 50 });
  const invite = useInviteStaff();
  const invAction = useStaffInvitationAction();
  const setActive = useSetStaffActive();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('support');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = staff.data?.data ?? [];
  const invites = (invitesQ.data?.data ?? []).filter((i) => i.status === 'pending');

  function onInvite() {
    setError(null);
    setNotice(null);
    if (!email.includes('@')) return setError('Enter a valid email.');
    invite.mutate(
      { email: email.trim(), staffRole: role },
      { onSuccess: () => { setNotice(`Invitation sent to ${email.trim()}.`); setEmail(''); }, onError: (e) => setError(apiError(e)) },
    );
  }

  async function toggleActive(m: StaffRow) {
    const action = m.isActive ? 'deactivate' : 'reactivate';
    const ok = await confirm({
      title: action === 'deactivate' ? 'Deactivate staff' : 'Reactivate staff',
      message: `${titleCase(action)} ${m.email ?? 'this member'}?`,
      confirmLabel: titleCase(action),
      tone: action === 'deactivate' ? 'destructive' : 'default',
    });
    if (ok) setActive.mutate({ id: m.id, action }, { onError: (e) => Alert.alert('Action failed', apiError(e)) });
  }

  async function revoke(inv: StaffInvitation) {
    const ok = await confirm({ title: 'Revoke invitation', message: `Revoke the pending invitation for ${inv.email}?`, confirmLabel: 'Revoke', tone: 'destructive' });
    if (ok) invAction.mutate({ id: inv.id, action: 'revoke' }, { onError: (e) => Alert.alert('Could not revoke', apiError(e)) });
  }

  return (
    <Screen>
      <ScreenHeader title="Staff" subtitle="Internal team + roles" right={<BackButton onPress={() => router.back()} />} />
      {staff.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[3] }}
          refreshControl={<RefreshControl refreshing={staff.isRefetching || invitesQ.isRefetching} onRefresh={() => { staff.refetch(); invitesQ.refetch(); }} />}
        >
          {notice ? <Banner text={notice} tone="success" /> : null}
          {error ? <Banner text={error} tone="danger" /> : null}

          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Invite staff</SectionLabel>
            <Card>
              <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="name@example.com"
                placeholderTextColor={p.mutedForeground}
                style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
              />
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 12, marginBottom: 6 }]}>Role</Text>
              <FilterChips options={ROLE_OPTIONS} value={role} onChange={setRole} />
              <View style={{ marginTop: 14 }}>
                <Button label={invite.isPending ? 'Sending…' : 'Send invite'} onPress={onInvite} loading={invite.isPending} disabled={invite.isPending} />
              </View>
            </Card>
          </View>

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Pending invitations</SectionLabel></View>
          {invites.length === 0 ? (
            <View style={{ paddingHorizontal: space[4] }}><Text style={[text.caption, { color: p.mutedForeground }]}>No pending invitations.</Text></View>
          ) : (
            <View style={{ paddingHorizontal: space[4], gap: 10 }}>
              {invites.map((inv) => (
                <Card key={inv.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{inv.email}</Text>
                    <Badge label="Pending" tone="warning" />
                  </View>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{titleCase(inv.staffRole)} · invited {formatDate(inv.createdAt)}</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                    <Button label="Resend" variant="secondary" onPress={() => invAction.mutate({ id: inv.id, action: 'resend' }, { onSuccess: () => setNotice(`Invitation to ${inv.email} resent.`), onError: (e) => Alert.alert('Could not resend', apiError(e)) })} />
                    <Button label="Revoke" variant="secondary" tone="danger" onPress={() => revoke(inv)} />
                  </View>
                </Card>
              ))}
            </View>
          )}

          <View style={{ paddingHorizontal: space[4] }}><SectionLabel>Team ({members.length})</SectionLabel></View>
          {members.length === 0 ? (
            <EmptyState title="No staff" body="Invite your first team member above." />
          ) : (
            <View style={{ paddingHorizontal: space[4], gap: 10 }}>
              {members.map((m) => (
                <Card key={m.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{staffName(m)}</Text>
                    <Badge label={m.isActive ? 'Active' : 'Inactive'} tone={m.isActive ? 'success' : 'neutral'} />
                  </View>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{titleCase(m.staffRole)}{m.joinedAt ? ` · joined ${formatDate(m.joinedAt)}` : ''}</Text>
                  <View style={{ marginTop: 10 }}>
                    <Button label={m.isActive ? 'Deactivate' : 'Reactivate'} variant="secondary" tone={m.isActive ? 'danger' : 'default'} onPress={() => toggleActive(m)} />
                  </View>
                </Card>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 2: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/homechef/staff.tsx
git commit -m "feat(mobile): homechef staff screen (list/invitations/invite/activate)"
```

---

## Task 5: Audit Log screen (filtered read-only list)

**Files:**
- Create: `apps/mobile/app/homechef/audit-log.tsx`

**Interfaces:**
- Consumes: `useAuditLogs` (Task 2); kit `Screen`, `ScreenHeader`, `BackButton`, `Card`, `Button`, `SearchField`, `LoadingRows`, `EmptyState`; theme; shared `AuditLogEntry`, `formatDateTime`, `titleCase`.
- Produces: default-exported route `AuditLog`.

- [ ] **Step 1: Create the screen with free-text filters + pagination + expandable change rows**

```tsx
// audit-log.tsx — HomeChef admin audit trail (read-only). Free-text action/entity
// filters + date range; FLAT { logs, total, page, limit } envelope (not Paginated).
import { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatDateTime, titleCase, type AuditLogEntry } from '@tesserix/homechef-shared';
import { BackButton, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, SearchField } from '../../components/kit';
import { useAuditLogs } from '../../lib/hooks';
import { usePalette, radius, space, text } from '../../lib/theme';

const LIMIT = 50;

function actorLabel(row: AuditLogEntry): string {
  if (!row.user) return row.userId ? row.userId.slice(0, 8) : 'System';
  const name = [row.user.firstName, row.user.lastName].filter(Boolean).join(' ').trim();
  return name || row.user.email || '—';
}

function ChangeToggle({ row }: { row: AuditLogEntry }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  if (!row.oldValue && !row.newValue) return null;
  if (!open) {
    return <Text onPress={() => setOpen(true)} style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.primary, marginTop: 6 }}>Show change</Text>;
  }
  return (
    <View style={{ marginTop: 6, gap: 4 }}>
      {row.oldValue ? <Text style={[text.mono, { color: p.destructive }]}>- {row.oldValue}</Text> : null}
      {row.newValue ? <Text style={[text.mono, { color: p.successFg }]}>+ {row.newValue}</Text> : null}
      <Text onPress={() => setOpen(false)} style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.primary }}>Hide</Text>
    </View>
  );
}

export default function AuditLog() {
  const p = usePalette();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);

  const q = useAuditLogs({
    page,
    limit: LIMIT,
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
  });
  const logs = q.data?.logs ?? [];
  const total = q.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (q.data?.limit || LIMIT)));

  function setFilter(fn: () => void) { fn(); setPage(1); }
  const hasFilter = action !== '' || entityType !== '';

  return (
    <Screen>
      <ScreenHeader title="Audit log" subtitle={`${total} entries`} right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], gap: 10, paddingBottom: space[2] }}>
        <SearchField value={action} onChangeText={(t) => setFilter(() => setAction(t))} placeholder="Filter action (e.g. chef.payout.update)" />
        <SearchField value={entityType} onChangeText={(t) => setFilter(() => setEntityType(t))} placeholder="Filter entity (e.g. chef)" />
        {hasFilter ? <Button label="Clear filters" variant="secondary" onPress={() => setFilter(() => { setAction(''); setEntityType(''); })} /> : null}
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : logs.length === 0 ? (
        <EmptyState title="No entries" body={hasFilter ? 'No log entries match your filters.' : 'No audit activity yet.'} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 10 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {logs.map((row) => (
            <Card key={row.id}>
              <Text style={[text.caption, { color: p.mutedForeground }]}>{formatDateTime(row.createdAt)} · {actorLabel(row)}</Text>
              <Text style={[text.title, { color: p.foreground, marginTop: 2 }]} numberOfLines={2}>{row.action}</Text>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>{titleCase(row.entityType)}{row.entityId ? ` · ${row.entityId.slice(0, 8)}` : ''}{row.ipAddress ? ` · ${row.ipAddress}` : ''}</Text>
              <ChangeToggle row={row} />
            </Card>
          ))}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <View style={{ flex: 1 }}><Button label="Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((n) => Math.max(1, n - 1))} /></View>
            <View style={{ flex: 1 }}><Button label="Next" variant="secondary" disabled={page >= totalPages} onPress={() => setPage((n) => n + 1)} /></View>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 2: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors. (If `text.mono` or `p.successFg` is not on the theme, substitute the nearest existing token — check `apps/mobile/lib/theme.ts` and `kit.tsx` `toneColors`, which reference `p.successFg`; `text.mono` is used by `ListRow`. Both exist.)

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/homechef/audit-log.tsx
git commit -m "feat(mobile): homechef audit log screen (filtered read-only trail)"
```

---

## Task 6: Mediation screen (inbox + confirm-gated relay/block)

**Files:**
- Create: `apps/mobile/app/homechef/mediation.tsx`

**Interfaces:**
- Consumes: `useMediationInbox`, `useMediationAction` (Task 2); `useConfirm`; kit `Screen`, `ScreenHeader`, `BackButton`, `Card`, `Button`, `Badge`, `Banner`, `LoadingRows`, `EmptyState`; theme; shared `MediatedMessage`, `MEDIATION_ROLE_LABEL`, `formatDateTime`.
- Produces: default-exported route `Mediation`.

- [ ] **Step 1: Create the screen — inbox rows with always-confirm relay + block**

```tsx
// mediation.tsx — HomeChef message mediation: relay or block pending messages
// between customers and chefs. Inbox polls every 20s. Relay + block are BOTH
// always confirm-gated on mobile (relay forwards PII irreversibly; block is silent).
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatDateTime, MEDIATION_ROLE_LABEL, type MediatedMessage } from '@tesserix/homechef-shared';
import { Badge, BackButton, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader } from '../../components/kit';
import { useMediationAction, useMediationInbox } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, space, text } from '../../lib/theme';

export default function Mediation() {
  const p = usePalette();
  const { confirm } = useConfirm();
  const q = useMediationInbox();
  const act = useMediationAction();
  const [busyId, setBusyId] = useState<string | null>(null);
  const inbox = q.data?.data ?? [];

  async function relay(m: MediatedMessage) {
    const ok = await confirm({
      title: m.piiDetected ? 'Relay a message with contact details?' : 'Relay this message?',
      message: m.piiDetected
        ? 'This message looks like it contains a phone number or address. Relaying lets the customer and chef contact each other directly and take the order off-platform.'
        : 'This delivers the message to the recipient.',
      confirmLabel: m.piiDetected ? 'Relay anyway' : 'Relay',
      tone: 'destructive',
    });
    if (!ok) return;
    setBusyId(m.id);
    act.mutate({ id: m.id, action: 'relay' }, { onError: (e) => Alert.alert('Could not relay', apiError(e)), onSettled: () => setBusyId(null) });
  }

  async function block(m: MediatedMessage) {
    const ok = await confirm({ title: 'Block this message?', message: 'It is never delivered. The sender is not told it was blocked.', confirmLabel: 'Block', tone: 'destructive' });
    if (!ok) return;
    setBusyId(m.id);
    act.mutate({ id: m.id, action: 'block' }, { onError: (e) => Alert.alert('Could not block', apiError(e)), onSettled: () => setBusyId(null) });
  }

  return (
    <Screen>
      <ScreenHeader title="Mediation" subtitle="Message relay queue" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : inbox.length === 0 ? (
        <EmptyState title="Inbox empty" body="No messages are waiting for mediation." />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 10 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
        >
          {inbox.map((m) => {
            const busy = busyId === m.id;
            return (
              <Card key={m.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
                    {MEDIATION_ROLE_LABEL[m.senderRole]} → {MEDIATION_ROLE_LABEL[m.recipientRole]}
                  </Text>
                  {m.piiDetected ? <Badge label="Contact details" tone="danger" /> : null}
                </View>
                <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>order {m.orderId.slice(0, 8)} · {formatDateTime(m.createdAt)}</Text>
                <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{m.content}</Text>
                {m.filename ? <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]}>Attachment: {m.filename}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <View style={{ flex: 1 }}><Button label="Relay" onPress={() => relay(m)} loading={busy && act.variables?.action === 'relay'} disabled={busy} /></View>
                  <View style={{ flex: 1 }}><Button label="Block" variant="secondary" tone="danger" onPress={() => block(m)} disabled={busy} /></View>
                </View>
              </Card>
            );
          })}
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 2: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors. (`act.variables` is typed as the mutation's argument `{ id; action } | undefined` — `act.variables?.action` is valid.)

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/homechef/mediation.tsx
git commit -m "feat(mobile): homechef mediation screen (inbox + confirm-gated relay/block)"
```

---

## Task 7: Hub wiring + final gate

**Files:**
- Modify: `apps/mobile/app/homechef/index.tsx`

**Interfaces:**
- Consumes: the four routes from Tasks 3–6.
- Produces: all four areas reachable; no `live:false` rows left in the HomeChef hub.

- [ ] **Step 1: Add the three new lucide icons to the import**

In `apps/mobile/app/homechef/index.tsx`, add `Settings2, ScrollText, MessagesSquare` to the existing `lucide-react-native` import (keep the existing icons):

```tsx
  Landmark, RotateCcw, CreditCard, SlidersHorizontal, Megaphone, Gift, Sparkles, TicketPercent,
  Settings2, ScrollText, MessagesSquare,
```

- [ ] **Step 2: Flip the existing Staff row to live**

Change:
```tsx
    { title: 'Staff', sub: 'Internal team + roles', icon: UserCog, route: '/homechef/staff', live: false },
```
to:
```tsx
    { title: 'Staff', sub: 'Internal team + roles', icon: UserCog, route: '/homechef/staff', live: true },
```

- [ ] **Step 3: Add the new "Settings & mediation" group**

Insert a new group object into the `SECTIONS` array, after the `People & quality` group (before the closing `] as const;`):

```tsx
  { group: 'Settings & mediation', items: [
    { title: 'Platform settings', sub: 'Fees, pricing & referrals', icon: Settings2, route: '/homechef/platform-settings', live: true },
    { title: 'Audit log', sub: 'Admin action trail', icon: ScrollText, route: '/homechef/audit-log', live: true },
    { title: 'Mediation', sub: 'Message relay queue', icon: MessagesSquare, route: '/homechef/mediation', live: true },
  ]},
```

- [ ] **Step 4: Run the full gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors across the whole app.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/homechef/index.tsx
git commit -m "feat(mobile): homechef hub — Settings & mediation group + Staff live (H6 complete)"
```

---

## Self-Review Notes

- **Spec coverage:** Platform Settings (3 editable cards, Policy+Pricing confirm-gated) → Tasks 1, 3. Staff (list + invitations + invite + deactivate/reactivate via `/reactivate`) → Tasks 2, 4. Audit Log (flat-envelope filtered read-only) → Tasks 2, 5. Mediation (20s-poll inbox + always-confirm relay/block) → Tasks 2, 6. Hub wiring → Task 7.
- **Resolved deviations baked in:** Policy+Pricing confirm (Referral direct); relay+block always confirm; `/reactivate` not `/activate`; resend not confirmed; `operatingDays: []` = open-every-day with visible copy; local flat `StaffRow` replacing the mis-shaped shared `StaffMember`; flat `{logs,total,page,limit}` audit envelope.
- **Immutability:** every form update uses functional setters and fresh object/array literals; config saves build a complete new typed object and spread `{ ...form, <overrides> }` — no in-place mutation. `toggleDay` returns a new sorted array.
- **Money review weight:** Platform Settings saves (live re-pricing) and Mediation relay/block (irreversible, PII) get extra reviewer attention.
- **Type consistency:** `StaffRow`/`StaffInvitation` are defined in Task 2 and consumed by Task 4; audit + mediation reuse shared types; the settings hooks' PUT bodies are exactly the shared config types.
