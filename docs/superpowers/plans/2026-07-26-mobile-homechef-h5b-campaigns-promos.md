# Mobile HomeChef H5 Part 2 — Campaigns + Promos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port HomeChef's Campaigns and Promos admin to the Expo mobile app at full parity — campaign compose/preview/schedule/send/test/cancel/delete + metrics, and promo create/edit/deactivate/reactivate + search + per-code analytics — then flip both hub rows live.

**Architecture:** Two new hc-gateway screen routes (`app/homechef/campaigns.tsx`, `app/homechef/promos.tsx`) backed by new TanStack Query hooks in `lib/hooks.ts`. Form-heavy composers are extracted into co-located non-route components under `components/homechef/` (files under `app/` become expo-router routes, so form components must live outside `app/`). Money is rupees throughout (no ÷100). Destructive/irreversible actions route through the existing `useConfirm` PromptSheet.

**Tech Stack:** Expo / expo-router, React 19, TanStack Query v5, axios via the `hc` client (`apps/mobile/lib/api.ts`), shared wire types from `@tesserix/homechef-shared`, kit component vocabulary (`apps/mobile/components/kit.tsx`).

## Global Constraints

- **No RN unit-test runner.** The test cycle for every task is the typecheck gate: `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, expecting **0 errors**. Rebuild the shared package first or tsc reports stale-dist missing exports.
- **Money is rupees** — pass raw numbers through `formatINR`, never ÷100.
- **Form numeric fields are held as strings**, `Number()`-converted on submit (web pattern).
- **Mobile hc delete verb is `hc.del`** (web uses `.delete`) — a straight port from web must rewrite `.delete` → `.del`.
- **`Campaign.segment` is a JSON string on the wire** — always run through `parseSegment()` before reading/editing; `CampaignInput.segment` is the parsed object form used in write bodies.
- **Promo DELETE = soft deactivate** (reversible via `PUT /promos/:id { isActive: true }`), not a hard delete.
- **Promo EditForm touches only 8 of 13 fields** — `code`, `fundingSource`, `chefId`, `validUntil` are immutable post-creation.
- **Create blocks submit when `fundingSource === 'chef'` && no `chefId`.**
- **`WinbackAnalytics.byTrigger` nil-slice** guard pattern is `(x ?? [])` — same defensive style applies to any nullable list.
- Commit directly to `main`, single-line conventional-commit messages, no signatures, no body.

---

## File Structure

- **Create** `apps/mobile/components/homechef/promo-forms.tsx` — `PromoCreateForm` (13-field create + conditional chef select + funding guard) and `PromoEditForm` (8-field editable subset), plus the local `PromoForm` / `EditForm` / `ApplicableTo` types and `APPLICABLE_OPTIONS` / `APPLICABLE_LABEL` / `EMPTY_PROMO_FORM` constants.
- **Create** `apps/mobile/components/homechef/campaign-form.tsx` — `CampaignForm` (segment builder + message composer + live preview + schedule panel) and exported status helpers `isEditableCampaign` / `isTerminalCampaign` / `CAMPAIGN_STATUS_TONE`.
- **Create** `apps/mobile/app/homechef/promos.tsx` — route: debounced search + paginated list + expandable per-row detail (analytics tiles + inline `PromoEditForm` + Reactivate) + deactivate + a collapsible `PromoCreateForm`.
- **Create** `apps/mobile/app/homechef/campaigns.tsx` — route: campaign list with status-gated per-item actions + inline metrics for sent campaigns + a `CampaignForm` for new/edit.
- **Modify** `apps/mobile/lib/hooks.ts` — add `qk` keys + campaigns hooks (Task 1) and promos hooks + wire body types (Task 2).
- **Modify** `apps/mobile/app/homechef/index.tsx:36,39` — flip Campaigns and Promos hub rows to `live: true` (Task 7).

---

## Task 1: Campaigns hooks

**Files:**
- Modify: `apps/mobile/lib/hooks.ts` (add imports, `qk` keys, hooks near the end)

**Interfaces:**
- Consumes: `hc` client (`get/post/put/del`) from `./api`; shared types `Campaign`, `CampaignInput`, `CampaignMetrics`, `SegmentCriteria`, `SegmentPreview` from `@tesserix/homechef-shared`.
- Produces:
  - `useCampaigns(): UseQueryResult<{ data: Campaign[] }>`
  - `useCampaignMetrics(id: string, enabled: boolean): UseQueryResult<CampaignMetrics>`
  - `previewCampaign(segment: SegmentCriteria): Promise<SegmentPreview>`
  - `useCreateCampaign()` → mutation `mutate(input: CampaignInput)`
  - `useUpdateCampaign()` → mutation `mutate({ id: string; input: CampaignInput })`
  - `useScheduleCampaign()` → mutation `mutate({ id: string; scheduledAt: string })`
  - `useCampaignAction()` → mutation `mutate({ id: string; action: 'send' | 'test' | 'cancel' | 'delete' })`

- [ ] **Step 1: Add the new shared-type imports**

In `apps/mobile/lib/hooks.ts`, extend the existing `import type { … } from '@tesserix/homechef-shared'` block (currently ending at `LoyaltyAnalytics,`) with:

```ts
  Campaign,
  CampaignInput,
  CampaignMetrics,
  SegmentCriteria,
  SegmentPreview,
```

- [ ] **Step 2: Add `qk` keys**

In the `qk` object (ends with `loyaltyAnalytics`), add:

```ts
  campaigns: ['hc', 'campaigns'] as const,
  campaignMetrics: (id: string) => ['hc', 'campaign-metrics', id] as const,
```

- [ ] **Step 3: Add the campaigns hooks at the end of the file**

Append after the Winback/Loyalty block:

```ts
// ---- Campaigns: list / metrics / preview / lifecycle -----------------------
export const useCampaigns = () =>
  useQuery({
    queryKey: qk.campaigns,
    queryFn: () => hc.get<{ data: Campaign[] }>('/campaigns', { page: 1, limit: 100 }),
  });

// Metrics exist only once a campaign has sent; caller passes enabled=status==='sent'.
export const useCampaignMetrics = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.campaignMetrics(id),
    queryFn: () => hc.get<CampaignMetrics>(`/campaigns/${id}/metrics`),
    enabled: enabled && !!id,
  });

// Imperative audience-size probe — used live in the compose form and re-run
// (best-effort) immediately before the send confirm so the count is never stale.
export const previewCampaign = (segment: SegmentCriteria) =>
  hc.post<SegmentPreview>('/campaigns/preview', { segment });

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CampaignInput) => hc.post<Campaign>('/campaigns', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.campaigns }),
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; input: CampaignInput }) => hc.put<Campaign>(`/campaigns/${a.id}`, a.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.campaigns }),
  });
}

export function useScheduleCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; scheduledAt: string }) =>
      hc.post(`/campaigns/${a.id}/schedule`, { scheduledAt: a.scheduledAt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.campaigns }),
  });
}

// send (irreversible mass-send) | test (admin only) | cancel | delete (draft/cancelled only).
export function useCampaignAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; action: 'send' | 'test' | 'cancel' | 'delete' }) =>
      a.action === 'delete' ? hc.del(`/campaigns/${a.id}`) : hc.post(`/campaigns/${a.id}/${a.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.campaigns }),
  });
}
```

- [ ] **Step 4: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): hc hooks for homechef campaigns (list/metrics/preview/lifecycle)"
```

---

## Task 2: Promos hooks + wire body types

**Files:**
- Modify: `apps/mobile/lib/hooks.ts` (add imports, `qk` keys, body types, hooks)

**Interfaces:**
- Consumes: `hc` client; shared types `Promo`, `PromoAnalytics`, `PromoDiscountType`, `PromoFundingSource`, `Paginated`, `ChefWithStats` (the last two already imported).
- Produces:
  - `PromoCreateBody` / `PromoUpdateBody` interfaces (exported)
  - `usePromos(p: { search?: string; page?: number; limit?: number }): UseQueryResult<Paginated<Promo>>`
  - `usePromoAnalytics(id: string, enabled: boolean): UseQueryResult<PromoAnalytics>`
  - `useCreatePromo()` → mutation `mutate(body: PromoCreateBody)`
  - `useUpdatePromo()` → mutation `mutate({ id: string; body: PromoUpdateBody })`
  - `useDeactivatePromo()` → mutation `mutate(id: string)`
  - (`useChefs` already exists — the promo chef picker reuses it.)

- [ ] **Step 1: Add the new shared-type imports**

Extend the `@tesserix/homechef-shared` import block (added to in Task 1) with:

```ts
  Promo,
  PromoAnalytics,
  PromoDiscountType,
  PromoFundingSource,
```

- [ ] **Step 2: Add `qk` keys**

In `qk`, after the campaign keys:

```ts
  promos: (p: object) => ['hc', 'promos', p] as const,
  promoAnalytics: (id: string) => ['hc', 'promo-analytics', id] as const,
```

- [ ] **Step 3: Add the promos body types + hooks at the end of the file**

```ts
// ---- Promos: search / analytics / create / edit / deactivate ---------------
// Wire bodies (numbers, not the string-held form types). chefId is sent only for
// chef-funded codes. applicableTo is a free string on the wire ('all' | 'new_users' | 'returning_users').
export interface PromoCreateBody {
  code: string;
  description: string;
  discountType: PromoDiscountType;
  discountValue: number;
  minOrderAmount: number;
  maxDiscount: number;
  usageLimit: number;
  perUserLimit: number;
  validUntil?: string;
  fundingSource: PromoFundingSource;
  applicableTo: string;
  chefId?: string;
  budgetCap: number;
}

export interface PromoUpdateBody {
  description: string;
  discountValue: number;
  minOrderAmount: number;
  maxDiscount: number;
  usageLimit: number;
  perUserLimit: number;
  budgetCap: number;
  applicableTo: string;
  isActive?: boolean; // only set on reactivate
}

export const usePromos = (p: { search?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.promos(p), queryFn: () => hc.get<Paginated<Promo>>('/promos', p) });

export const usePromoAnalytics = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.promoAnalytics(id),
    queryFn: () => hc.get<PromoAnalytics>(`/promos/${id}/analytics`),
    enabled: enabled && !!id,
  });

export function useCreatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PromoCreateBody) => hc.post<Promo>('/promos', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'promos'] }),
  });
}

export function useUpdatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; body: PromoUpdateBody }) => hc.put<Promo>(`/promos/${a.id}`, a.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'promos'] }),
  });
}

// DELETE = soft deactivate (reversible via useUpdatePromo with { isActive: true }).
export function useDeactivatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => hc.del(`/promos/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'promos'] }),
  });
}
```

- [ ] **Step 4: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): hc hooks for homechef promos (search/analytics/create/edit/deactivate)"
```

---

## Task 3: Promo create/edit form components

**Files:**
- Create: `apps/mobile/components/homechef/promo-forms.tsx`

**Interfaces:**
- Consumes: `useCreatePromo`, `useUpdatePromo`, `useChefs`, `PromoCreateBody`, `PromoUpdateBody` (Task 2); `useConfirm` from `../prompt`; kit `Card`, `Button`, `FilterChips`, `Banner`; theme; shared `Promo`, `PromoDiscountType`, `PromoFundingSource`, `Paginated`, `ChefWithStats`, `formatINR`.
- Produces (exported):
  - `ApplicableTo = 'all' | 'new_users' | 'returning_users'`
  - `APPLICABLE_OPTIONS`, `APPLICABLE_LABEL`
  - `PromoCreateForm({ onDone }: { onDone: () => void })` — self-contained create card
  - `PromoEditForm({ promo, onDone }: { promo: Promo; onDone: () => void })` — self-contained edit card, includes a Reactivate button when `!promo.isActive`

- [ ] **Step 1: Create the file with types, constants, and a shared numeric-field control**

```tsx
// promo-forms.tsx — HomeChef promo create/edit composers. Route files live under
// app/, so these form components live here (outside app/) to avoid becoming routes.
// Numeric fields are string-held and Number()-converted on submit (web pattern).
import { useMemo, useState } from 'react';
import { Alert, Switch, Text, TextInput, View } from 'react-native';
import {
  formatINR,
  type Promo,
  type PromoDiscountType,
  type PromoFundingSource,
} from '@tesserix/homechef-shared';
import { Banner, Button, Card, FilterChips } from '../kit';
import { useChefs, useCreatePromo, useUpdatePromo, type PromoCreateBody, type PromoUpdateBody } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../prompt';
import { usePalette, radius, space, text } from '../../lib/theme';

export type ApplicableTo = 'all' | 'new_users' | 'returning_users';

export const APPLICABLE_OPTIONS: { key: ApplicableTo; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'new_users', label: 'New users' },
  { key: 'returning_users', label: 'Returning users' },
];
export const APPLICABLE_LABEL: Record<string, string> = {
  all: 'Everyone',
  new_users: 'New users',
  returning_users: 'Returning users',
};

const DISCOUNT_OPTIONS: { key: PromoDiscountType; label: string }[] = [
  { key: 'percentage', label: 'Percentage' },
  { key: 'fixed', label: 'Fixed ₹' },
];
const FUNDING_OPTIONS: { key: PromoFundingSource; label: string }[] = [
  { key: 'platform', label: 'Platform' },
  { key: 'chef', label: 'Chef' },
];

function Field({
  label,
  value,
  onChangeText,
  numeric,
  autoCapitalize,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  numeric?: boolean;
  autoCapitalize?: 'none' | 'characters';
  placeholder?: string;
}) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={p.mutedForeground}
        style={{ height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, fontFamily: 'InterTight', fontSize: 15 }}
      />
    </View>
  );
}

function Selector<T extends string>({ label, options, value, onChange }: { label: string; options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>{label}</Text>
      <FilterChips options={options} value={value} onChange={onChange} />
    </View>
  );
}
```

Note: `FilterChips` renders inside a horizontal ScrollView with its own `paddingHorizontal`; it is used here as the segmented single-select control for discount type, funding source, and applies-to.

- [ ] **Step 2: Add `PromoCreateForm`**

Append to the file:

```tsx
export function PromoCreateForm({ onDone }: { onDone: () => void }) {
  const p = usePalette();
  const create = useCreatePromo();
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [discountType, setDiscountType] = useState<PromoDiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [minOrderAmount, setMinOrderAmount] = useState('0');
  const [maxDiscount, setMaxDiscount] = useState('0');
  const [usageLimit, setUsageLimit] = useState('0');
  const [perUserLimit, setPerUserLimit] = useState('1');
  const [validUntil, setValidUntil] = useState('');
  const [fundingSource, setFundingSource] = useState<PromoFundingSource>('platform');
  const [applicableTo, setApplicableTo] = useState<ApplicableTo>('all');
  const [chefId, setChefId] = useState('');
  const [budgetCap, setBudgetCap] = useState('0');
  const [error, setError] = useState<string | null>(null);

  // Chef list is fetched only once chef-funding is chosen (mirrors the web lazy fetch).
  const chefsQ = useChefs(fundingSource === 'chef' ? { page: 1, limit: 200 } : {});
  const chefs = fundingSource === 'chef' ? chefsQ.data?.data ?? [] : [];

  function submit() {
    setError(null);
    if (!code.trim()) return setError('A code is required.');
    if (Number(discountValue) <= 0) return setError('Discount must be greater than zero.');
    if (fundingSource === 'chef' && !chefId) return setError('Pick the chef whose payout funds this code.');
    const body: PromoCreateBody = {
      code: code.trim().toUpperCase(),
      description: description.trim(),
      discountType,
      discountValue: Number(discountValue),
      minOrderAmount: Number(minOrderAmount),
      maxDiscount: Number(maxDiscount),
      usageLimit: Number(usageLimit),
      perUserLimit: Number(perUserLimit),
      validUntil: validUntil || undefined,
      fundingSource,
      applicableTo,
      chefId: fundingSource === 'chef' ? chefId : undefined,
      budgetCap: Number(budgetCap),
    };
    create.mutate(body, {
      onSuccess: () => onDone(),
      onError: (e) => Alert.alert('Could not create promo', apiError(e)),
    });
  }

  return (
    <Card>
      {error ? <View style={{ marginBottom: 8 }}><Banner text={error} tone="danger" /></View> : null}
      <Field label="Code" value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="SUMMER20" />
      <Field label="Description" value={description} onChangeText={setDescription} />
      <Selector label="Discount type" options={DISCOUNT_OPTIONS} value={discountType} onChange={setDiscountType} />
      <Field label={discountType === 'percentage' ? 'Discount %' : 'Discount ₹'} value={discountValue} onChangeText={setDiscountValue} numeric />
      <Field label="Min order amount (₹)" value={minOrderAmount} onChangeText={setMinOrderAmount} numeric />
      <Field label="Max discount (₹, 0 = uncapped)" value={maxDiscount} onChangeText={setMaxDiscount} numeric />
      <Field label="Usage limit (0 = unlimited)" value={usageLimit} onChangeText={setUsageLimit} numeric />
      <Field label="Per-user limit" value={perUserLimit} onChangeText={setPerUserLimit} numeric />
      <Field label="Valid until (ISO date, optional)" value={validUntil} onChangeText={setValidUntil} placeholder="2026-12-31" autoCapitalize="none" />
      <Selector label="Funding source" options={FUNDING_OPTIONS} value={fundingSource} onChange={setFundingSource} />
      {fundingSource === 'chef' ? (
        <View style={{ marginTop: 12 }}>
          <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Chef</Text>
          {chefsQ.isLoading ? (
            <Text style={[text.body, { color: p.mutedForeground }]}>Loading chefs…</Text>
          ) : (
            <FilterChips
              options={chefs.map((c) => ({ key: c.id, label: c.businessName }))}
              value={chefId}
              onChange={setChefId}
            />
          )}
        </View>
      ) : null}
      <Selector label="Applies to" options={APPLICABLE_OPTIONS} value={applicableTo} onChange={setApplicableTo} />
      <Field label="Budget cap (₹, 0 = uncapped)" value={budgetCap} onChangeText={setBudgetCap} numeric />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="secondary" onPress={onDone} /></View>
        <View style={{ flex: 1 }}><Button label={create.isPending ? 'Creating…' : 'Create promo'} onPress={submit} loading={create.isPending} disabled={create.isPending} /></View>
      </View>
    </Card>
  );
}
```

- [ ] **Step 3: Add `PromoEditForm`**

Append to the file:

```tsx
export function PromoEditForm({ promo, onDone }: { promo: Promo; onDone: () => void }) {
  const update = useUpdatePromo();
  const { confirm } = useConfirm();
  const [description, setDescription] = useState(promo.description);
  const [discountValue, setDiscountValue] = useState(String(promo.discountValue));
  const [minOrderAmount, setMinOrderAmount] = useState(String(promo.minOrderAmount));
  const [maxDiscount, setMaxDiscount] = useState(String(promo.maxDiscount));
  const [usageLimit, setUsageLimit] = useState(String(promo.usageLimit));
  const [perUserLimit, setPerUserLimit] = useState(String(promo.perUserLimit));
  const [budgetCap, setBudgetCap] = useState(String(promo.budgetCap));
  const [applicableTo, setApplicableTo] = useState<ApplicableTo>((promo.applicableTo as ApplicableTo) || 'all');
  const [error, setError] = useState<string | null>(null);

  const base = useMemo<PromoUpdateBody>(
    () => ({
      description: description.trim(),
      discountValue: Number(discountValue),
      minOrderAmount: Number(minOrderAmount),
      maxDiscount: Number(maxDiscount),
      usageLimit: Number(usageLimit),
      perUserLimit: Number(perUserLimit),
      budgetCap: Number(budgetCap),
      applicableTo,
    }),
    [description, discountValue, minOrderAmount, maxDiscount, usageLimit, perUserLimit, budgetCap, applicableTo],
  );

  function save(patch?: Partial<PromoUpdateBody>) {
    setError(null);
    update.mutate(
      { id: promo.id, body: { ...base, ...patch } },
      { onSuccess: () => onDone(), onError: (e) => setError(apiError(e)) },
    );
  }

  return (
    <Card>
      {error ? <View style={{ marginBottom: 8 }}><Banner text={error} tone="danger" /></View> : null}
      <Field label="Description" value={description} onChangeText={setDescription} />
      <Field label="Discount value" value={discountValue} onChangeText={setDiscountValue} numeric />
      <Field label="Min order amount (₹)" value={minOrderAmount} onChangeText={setMinOrderAmount} numeric />
      <Field label="Max discount (₹, 0 = uncapped)" value={maxDiscount} onChangeText={setMaxDiscount} numeric />
      <Field label="Usage limit (0 = unlimited)" value={usageLimit} onChangeText={setUsageLimit} numeric />
      <Field label="Per-user limit" value={perUserLimit} onChangeText={setPerUserLimit} numeric />
      <Field label="Budget cap (₹, 0 = uncapped)" value={budgetCap} onChangeText={setBudgetCap} numeric />
      <Selector label="Applies to" options={APPLICABLE_OPTIONS} value={applicableTo} onChange={setApplicableTo} />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="secondary" onPress={onDone} /></View>
        <View style={{ flex: 1 }}><Button label={update.isPending ? 'Saving…' : 'Save'} onPress={() => save()} loading={update.isPending} disabled={update.isPending} /></View>
      </View>
      {!promo.isActive ? (
        <View style={{ marginTop: 10 }}>
          <Button
            label="Reactivate code"
            variant="secondary"
            onPress={async () => {
              if (await confirm({ title: 'Reactivate code?', message: `${promo.code} will start working again.`, confirmLabel: 'Reactivate' })) {
                save({ isActive: true });
              }
            }}
          />
        </View>
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 4: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors. (`FilterChips` is generically typed `<T extends string>`; chef ids and applicable/discount/funding keys all satisfy it.)

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/components/homechef/promo-forms.tsx
git commit -m "feat(mobile): homechef promo create/edit form components"
```

---

## Task 4: Promos screen (search + list + detail analytics + deactivate/reactivate)

**Files:**
- Create: `apps/mobile/app/homechef/promos.tsx`

**Interfaces:**
- Consumes: `usePromos`, `usePromoAnalytics`, `useDeactivatePromo` (Task 2); `PromoCreateForm`, `PromoEditForm`, `APPLICABLE_LABEL` (Task 3); `useConfirm` from `../../components/prompt`; kit `Screen`, `ScreenHeader`, `BackButton`, `SearchField`, `Card`, `Button`, `Badge`, `StatTile`, `StatGrid`, `LoadingRows`, `EmptyState`; shared `Promo`, `formatINR`, `formatDate`.
- Produces: default-exported route component `Promos`.

- [ ] **Step 1: Create the screen with debounced search + list + New-promo toggle**

```tsx
// promos.tsx — HomeChef discount codes: search, create, per-row analytics + edit,
// deactivate (soft) / reactivate. hc gateway. Money is rupees.
import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react-native';
import { formatDate, formatINR, formatPct, type Promo } from '@tesserix/homechef-shared';
import {
  Badge, BackButton, Button, Card, EmptyState, LoadingRows, Screen, ScreenHeader, SearchField, StatGrid, StatTile,
} from '../../components/kit';
import { PromoCreateForm, PromoEditForm, APPLICABLE_LABEL } from '../../components/homechef/promo-forms';
import { usePromoAnalytics, usePromos, useDeactivatePromo } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, space, text } from '../../lib/theme';

const PAGE_LIMIT = 20;

export default function Promos() {
  const p = usePalette();
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // Debounce the search box (300ms) and reset to page 1 on a new term.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(rawSearch.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const q = usePromos({ search: search || undefined, page, limit: PAGE_LIMIT });
  const promos = q.data?.data ?? [];
  const meta = q.data?.pagination;

  return (
    <Screen>
      <ScreenHeader
        title="Promos"
        subtitle="Discount codes"
        right={<BackButton onPress={() => router.back()} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[3] }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
      >
        <View style={{ paddingHorizontal: space[4], gap: 10 }}>
          <SearchField value={rawSearch} onChangeText={setRawSearch} placeholder="Search codes" />
          <Button
            label={creating ? 'Close new promo' : 'New promo'}
            variant={creating ? 'secondary' : 'primary'}
            onPress={() => setCreating((v) => !v)}
          />
          {creating ? <PromoCreateForm onDone={() => setCreating(false)} /> : null}
        </View>

        {q.isLoading ? (
          <LoadingRows />
        ) : promos.length === 0 ? (
          <EmptyState title="No promos" body={search ? 'No codes match your search.' : 'Create your first discount code.'} />
        ) : (
          <View style={{ paddingHorizontal: space[4], gap: 10 }}>
            {promos.map((promo) => (
              <PromoRow key={promo.id} promo={promo} open={openId === promo.id} onToggle={() => setOpenId((id) => (id === promo.id ? null : promo.id))} />
            ))}
          </View>
        )}

        {meta && (meta.hasPrev || meta.hasNext) ? (
          <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: space[4] }}>
            <View style={{ flex: 1 }}><Button label="Previous" variant="secondary" disabled={!meta.hasPrev} onPress={() => setPage((n) => Math.max(1, n - 1))} /></View>
            <View style={{ flex: 1 }}><Button label="Next" variant="secondary" disabled={!meta.hasNext} onPress={() => setPage((n) => n + 1)} /></View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
```

- [ ] **Step 2: Add the `PromoRow` (summary + expandable detail with analytics + edit + deactivate)**

Append to the same file:

```tsx
function PromoRow({ promo, open, onToggle }: { promo: Promo; open: boolean; onToggle: () => void }) {
  const p = usePalette();
  const { confirm } = useConfirm();
  const deactivate = useDeactivatePromo();
  const analytics = usePromoAnalytics(promo.id, open);

  const discount = promo.discountType === 'percentage' ? `${promo.discountValue}%` : formatINR(promo.discountValue);
  const a = analytics.data;

  const tiles: { label: string; value: string }[] = [
    { label: 'Redemptions', value: String(a?.redemptions ?? 0) },
    { label: 'Total discount', value: formatINR(a?.totalDiscount) },
    { label: 'Unique users', value: String(a?.uniqueUsers ?? 0) },
    { label: 'Budget left', value: promo.budgetCap > 0 ? formatINR(a?.budgetRemaining) : 'Uncapped' },
    { label: 'Budget used', value: promo.budgetCap > 0 ? `${(a?.budgetUtilisation ?? 0).toFixed(1)}%` : '—' },
  ];

  return (
    <Card>
      <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[text.title, { color: p.foreground }]}>{promo.code}</Text>
            <Badge label={promo.isActive ? 'Active' : 'Inactive'} tone={promo.isActive ? 'success' : 'neutral'} />
          </View>
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
            {discount} · {APPLICABLE_LABEL[promo.applicableTo] ?? promo.applicableTo} · {promo.fundingSource} · used {promo.usageCount}/{promo.usageLimit || '∞'}
          </Text>
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
            Budget {formatINR(promo.budgetSpent)}/{promo.budgetCap > 0 ? formatINR(promo.budgetCap) : '∞'} · expires {promo.validUntil ? formatDate(promo.validUntil) : 'never'}
          </Text>
        </View>
        {open ? <ChevronDown size={18} color={p.mutedForeground} /> : <ChevronRight size={18} color={p.mutedForeground} />}
      </Pressable>

      {open ? (
        <View style={{ marginTop: 12, gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {tiles.map((t) => (
              <View key={t.label} style={{ flexGrow: 1, flexBasis: '30%', minWidth: 96 }}>
                <StatTile label={t.label} value={t.value} />
              </View>
            ))}
          </View>
          <PromoEditForm promo={promo} onDone={onToggle} />
          {promo.isActive ? (
            <Button
              label={deactivate.isPending ? 'Deactivating…' : 'Deactivate code'}
              variant="secondary"
              tone="danger"
              loading={deactivate.isPending}
              onPress={async () => {
                const ok = await confirm({
                  title: 'Deactivate code?',
                  message: 'The code stops working immediately. It can be reactivated later.',
                  confirmLabel: 'Deactivate',
                  tone: 'destructive',
                });
                if (ok) deactivate.mutate(promo.id, { onError: (e) => Alert.alert('Could not deactivate', apiError(e)) });
              }}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 3: Add the missing `Alert` import**

`PromoRow` uses `Alert.alert`. Add `Alert` to the `react-native` import at the top:

```tsx
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
```

Remove the now-unused `formatPct` / `Plus` / `StatGrid` imports if tsc flags them (`StatTile` is used, `StatGrid` and `Plus` and `formatPct` are not — delete them from their import lines to keep tsc clean).

- [ ] **Step 4: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/homechef/promos.tsx
git commit -m "feat(mobile): homechef promos screen (search/list/analytics/edit/deactivate)"
```

---

## Task 5: Campaign compose form component

**Files:**
- Create: `apps/mobile/components/homechef/campaign-form.tsx`

**Interfaces:**
- Consumes: `useCreateCampaign`, `useUpdateCampaign`, `useScheduleCampaign`, `previewCampaign` (Task 1); kit `Card`, `Button`, `FilterChips`, `Banner`; shared `Campaign`, `CampaignInput`, `CampaignStatus`, `SegmentCriteria`, `SegmentPreview`, `parseSegment`.
- Produces (exported):
  - `CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone>`
  - `isEditableCampaign(s: CampaignStatus): boolean`
  - `isTerminalCampaign(s: CampaignStatus): boolean`
  - `CampaignForm({ existing, onDone }: { existing?: Campaign; onDone: () => void })` — compose card; when `existing` is set it edits (PUT), else creates (POST). Includes a live Preview button and an ISO-datetime schedule field.

- [ ] **Step 1: Create the file with status helpers, tone map, and the roles/recency/subscription option sets**

```tsx
// campaign-form.tsx — HomeChef campaign composer: segment builder + message
// composer + live audience preview + schedule. Lives outside app/ (route dir).
import { useState } from 'react';
import { Alert, Switch, Text, TextInput, View } from 'react-native';
import {
  parseSegment,
  type Campaign,
  type CampaignInput,
  type CampaignStatus,
  type SegmentCriteria,
  type SegmentPreview,
} from '@tesserix/homechef-shared';
import { Banner, Button, Card, FilterChips, type Tone } from '../kit';
import { previewCampaign, useCreateCampaign, useScheduleCampaign, useUpdateCampaign } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { usePalette, radius, space, text } from '../../lib/theme';

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone> = {
  draft: 'neutral',
  scheduled: 'info',
  queued: 'info',
  sending: 'warning',
  sent: 'success',
  cancelled: 'danger',
};

// Editable/sendable only before it has gone out; UpdateCampaign 409s past draft/scheduled.
export function isEditableCampaign(s: CampaignStatus): boolean {
  return s === 'draft' || s === 'scheduled';
}
export function isTerminalCampaign(s: CampaignStatus): boolean {
  return s === 'sent' || s === 'cancelled' || s === 'sending' || s === 'queued';
}

const ROLES = ['customer', 'chef', 'delivery'] as const;
const RECENCY_OPTIONS: { key: '' | 'active' | 'lapsed'; label: string }[] = [
  { key: '', label: 'Any recency' },
  { key: 'active', label: 'Active' },
  { key: 'lapsed', label: 'Lapsed' },
];
const SUBSCRIPTION_OPTIONS: { key: '' | 'active' | 'paused' | 'none'; label: string }[] = [
  { key: '', label: 'Any subscription' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'none', label: 'None' },
];

function FormField({ label, value, onChangeText, multiline, numeric, placeholder }: { label: string; value: string; onChangeText: (t: string) => void; multiline?: boolean; numeric?: boolean; placeholder?: string }) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        keyboardType={numeric ? 'numeric' : 'default'}
        placeholder={placeholder}
        placeholderTextColor={p.mutedForeground}
        style={{ minHeight: multiline ? 88 : 44, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.muted, color: p.foreground, paddingHorizontal: 12, paddingVertical: multiline ? 10 : 0, fontFamily: 'InterTight', fontSize: 15, textAlignVertical: multiline ? 'top' : 'center' }}
      />
    </View>
  );
}
```

- [ ] **Step 2: Add the `CampaignForm` body (state + segment builder + composer)**

Append:

```tsx
export function CampaignForm({ existing, onDone }: { existing?: Campaign; onDone: () => void }) {
  const p = usePalette();
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const schedule = useScheduleCampaign();

  const seed: SegmentCriteria = existing ? parseSegment(existing.segment) : { recency: '', subscription: '' };
  const [name, setName] = useState(existing?.name ?? '');
  const [sendPush, setSendPush] = useState(existing?.sendPush ?? true);
  const [sendEmail, setSendEmail] = useState(existing?.sendEmail ?? false);
  const [pushTitle, setPushTitle] = useState(existing?.pushTitle ?? '');
  const [pushBody, setPushBody] = useState(existing?.pushBody ?? '');
  const [emailSubject, setEmailSubject] = useState(existing?.emailSubject ?? '');
  const [emailHtml, setEmailHtml] = useState(existing?.emailHtml ?? '');
  const [roles, setRoles] = useState<string[]>(seed.roles ?? []);
  const [recency, setRecency] = useState<'' | 'active' | 'lapsed'>(seed.recency ?? '');
  const [recencyDays, setRecencyDays] = useState(seed.recencyDays != null ? String(seed.recencyDays) : '');
  const [subscription, setSubscription] = useState<'' | 'active' | 'paused' | 'none'>(seed.subscription ?? '');
  const [cities, setCities] = useState((seed.cities ?? []).join(', '));
  const [newWithinDays, setNewWithinDays] = useState(seed.newWithinDays != null ? String(seed.newWithinDays) : '');
  const [scheduledAt, setScheduledAt] = useState(existing?.scheduledAt ?? '');
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildSegment(): SegmentCriteria {
    return {
      roles: roles.length ? roles : undefined,
      recency,
      recencyDays: recencyDays ? Number(recencyDays) : undefined,
      cities: cities.trim() ? cities.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
      subscription,
      newWithinDays: newWithinDays ? Number(newWithinDays) : undefined,
    };
  }

  function buildInput(): CampaignInput {
    return { name: name.trim(), sendPush, sendEmail, pushTitle, pushBody, emailSubject, emailHtml, segment: buildSegment() };
  }

  function toggleRole(role: string) {
    setRoles((rs) => (rs.includes(role) ? rs.filter((r) => r !== role) : [...rs, role]));
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await previewCampaign(buildSegment()));
    } catch (e) {
      setError(apiError(e));
    } finally {
      setPreviewing(false);
    }
  }

  function validate(): string | null {
    if (!name.trim()) return 'Give the campaign a name.';
    if (!sendPush && !sendEmail) return 'Pick at least one channel.';
    if (sendPush && !pushTitle.trim()) return 'Push needs a title.';
    if (sendEmail && !emailSubject.trim()) return 'Email needs a subject.';
    return null;
  }

  function save() {
    const v = validate();
    if (v) return setError(v);
    setError(null);
    const input = buildInput();
    const onErr = (e: unknown) => Alert.alert('Could not save campaign', apiError(e));
    if (existing) {
      update.mutate({ id: existing.id, input }, { onSuccess: () => maybeSchedule(existing.id), onError: onErr });
    } else {
      create.mutate(input, { onSuccess: (c) => maybeSchedule(c.id), onError: onErr });
    }
  }

  // If a schedule time was entered, apply it after the draft is saved; else finish.
  function maybeSchedule(id: string) {
    if (scheduledAt.trim()) {
      schedule.mutate({ id, scheduledAt: scheduledAt.trim() }, { onSuccess: () => onDone(), onError: (e) => Alert.alert('Saved, but scheduling failed', apiError(e)) });
    } else {
      onDone();
    }
  }

  const busy = create.isPending || update.isPending || schedule.isPending;

  return (
    <Card>
      {error ? <View style={{ marginBottom: 8 }}><Banner text={error} tone="danger" /></View> : null}
      <FormField label="Campaign name" value={name} onChangeText={setName} />

      <Text style={[text.label, { color: p.foreground, marginTop: 16, marginBottom: 6 }]}>Audience</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Roles</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {ROLES.map((role) => {
          const on = roles.includes(role);
          return (
            <Button key={role} label={role} variant={on ? 'primary' : 'secondary'} onPress={() => toggleRole(role)} />
          );
        })}
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Recency</Text>
        <FilterChips options={RECENCY_OPTIONS} value={recency} onChange={setRecency} />
      </View>
      <FormField label="Recency window (days, optional)" value={recencyDays} onChangeText={setRecencyDays} numeric />
      <View style={{ marginTop: 12 }}>
        <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 6 }]}>Subscription</Text>
        <FilterChips options={SUBSCRIPTION_OPTIONS} value={subscription} onChange={setSubscription} />
      </View>
      <FormField label="Cities (comma-separated, optional)" value={cities} onChangeText={setCities} />
      <FormField label="New within (days, optional)" value={newWithinDays} onChangeText={setNewWithinDays} numeric />

      <View style={{ marginTop: 12 }}>
        <Button label={previewing ? 'Previewing…' : 'Preview audience'} variant="secondary" onPress={runPreview} loading={previewing} />
        {preview ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]}>
            {preview.matched} matched · {preview.reachablePush} reachable push · {preview.reachableEmail} reachable email
          </Text>
        ) : null}
      </View>

      <Text style={[text.label, { color: p.foreground, marginTop: 16, marginBottom: 6 }]}>Message</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[text.body, { color: p.foreground }]}>Send push</Text>
        <Switch value={sendPush} onValueChange={setSendPush} />
      </View>
      {sendPush ? (
        <>
          <FormField label="Push title" value={pushTitle} onChangeText={setPushTitle} />
          <FormField label="Push body" value={pushBody} onChangeText={setPushBody} multiline />
        </>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <Text style={[text.body, { color: p.foreground }]}>Send email</Text>
        <Switch value={sendEmail} onValueChange={setSendEmail} />
      </View>
      {sendEmail ? (
        <>
          <FormField label="Email subject" value={emailSubject} onChangeText={setEmailSubject} />
          <FormField label="Email HTML" value={emailHtml} onChangeText={setEmailHtml} multiline />
        </>
      ) : null}

      <FormField label="Schedule at (ISO datetime, optional)" value={scheduledAt} onChangeText={setScheduledAt} placeholder="2026-08-01T09:00:00Z" />

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="secondary" onPress={onDone} /></View>
        <View style={{ flex: 1 }}><Button label={busy ? 'Saving…' : existing ? 'Save changes' : 'Create draft'} onPress={save} loading={busy} disabled={busy} /></View>
      </View>
    </Card>
  );
}
```

- [ ] **Step 3: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors. (`create.mutate`'s `onSuccess` receives the created `Campaign` — `useCreateCampaign` is typed `hc.post<Campaign>` so `c.id` is typed.)

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/components/homechef/campaign-form.tsx
git commit -m "feat(mobile): homechef campaign compose form (segment builder + composer + schedule)"
```

---

## Task 6: Campaigns screen (list + status-gated actions + metrics)

**Files:**
- Create: `apps/mobile/app/homechef/campaigns.tsx`

**Interfaces:**
- Consumes: `useCampaigns`, `useCampaignMetrics`, `useCampaignAction`, `previewCampaign` (Task 1); `CampaignForm`, `CAMPAIGN_STATUS_TONE`, `isEditableCampaign`, `isTerminalCampaign` (Task 5); `useConfirm` from `../../components/prompt`; kit `Screen`, `ScreenHeader`, `BackButton`, `Card`, `Button`, `Badge`, `Metric`, `LoadingRows`, `EmptyState`, `SectionLabel`; shared `Campaign`, `parseSegment`, `formatDateTime`, `titleCase`.
- Produces: default-exported route component `Campaigns`.

- [ ] **Step 1: Create the screen shell with the new-campaign toggle and list**

```tsx
// campaigns.tsx — HomeChef push/email campaigns: compose, preview, schedule, send,
// test, cancel, delete + sent-campaign metrics. hc gateway. Sends are irreversible.
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { formatDateTime, titleCase, type Campaign } from '@tesserix/homechef-shared';
import {
  Badge, BackButton, Button, Card, EmptyState, LoadingRows, Metric, Screen, ScreenHeader, SectionLabel,
} from '../../components/kit';
import { CampaignForm, CAMPAIGN_STATUS_TONE, isEditableCampaign, isTerminalCampaign } from '../../components/homechef/campaign-form';
import { previewCampaign, useCampaignAction, useCampaignMetrics, useCampaigns } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { usePalette, space, text } from '../../lib/theme';

export default function Campaigns() {
  const p = usePalette();
  const q = useCampaigns();
  const [composing, setComposing] = useState(false);
  const campaigns = q.data?.data ?? [];

  return (
    <Screen>
      <ScreenHeader title="Campaigns" subtitle="Push/email blasts" right={<BackButton onPress={() => router.back()} />} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space[10], gap: space[3] }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} />}
      >
        <View style={{ paddingHorizontal: space[4], gap: 10 }}>
          <Button
            label={composing ? 'Close composer' : 'New campaign'}
            variant={composing ? 'secondary' : 'primary'}
            onPress={() => setComposing((v) => !v)}
          />
          {composing ? <CampaignForm onDone={() => setComposing(false)} /> : null}
        </View>

        {q.isLoading ? (
          <LoadingRows />
        ) : campaigns.length === 0 ? (
          <EmptyState title="No campaigns" body="Compose your first push or email blast." />
        ) : (
          <View style={{ paddingHorizontal: space[4], gap: 10 }}>
            {campaigns.map((c) => (
              <CampaignRow key={c.id} campaign={c} />
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
```

- [ ] **Step 2: Add `CampaignRow` with status-gated actions, edit, and metrics**

Append:

```tsx
function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  const p = usePalette();
  const { confirm } = useConfirm();
  const action = useCampaignAction();
  const [editing, setEditing] = useState(false);
  const metrics = useCampaignMetrics(c.id, c.status === 'sent');

  const canEdit = isEditableCampaign(c.status);
  const canCancel = c.status === 'draft' || c.status === 'scheduled';
  const canDelete = c.status === 'draft' || c.status === 'cancelled';
  const canLifecycle = !isTerminalCampaign(c.status); // send / test / schedule window

  async function onSend() {
    // Re-fetch a fresh audience count immediately before the confirm so the number is never stale.
    let detail = 'This sends immediately and cannot be undone.';
    try {
      const pv = await previewCampaign(parseSegmentSafe(c));
      detail = `${pv.matched} recipients will be messaged immediately. This cannot be undone.`;
    } catch {
      // best-effort — fall back to the blunt warning
    }
    const ok = await confirm({ title: 'Send campaign?', message: detail, confirmLabel: 'Send now', tone: 'destructive' });
    if (ok) action.mutate({ id: c.id, action: 'send' }, { onError: (e) => Alert.alert('Send failed', apiError(e)) });
  }

  async function onCancel() {
    if (await confirm({ title: 'Cancel campaign?', message: 'This stops it from sending.', confirmLabel: 'Cancel campaign', tone: 'destructive' })) {
      action.mutate({ id: c.id, action: 'cancel' }, { onError: (e) => Alert.alert('Could not cancel', apiError(e)) });
    }
  }

  async function onDelete() {
    if (await confirm({ title: 'Delete campaign?', message: 'This permanently removes the draft.', confirmLabel: 'Delete', tone: 'destructive' })) {
      action.mutate({ id: c.id, action: 'delete' }, { onError: (e) => Alert.alert('Could not delete', apiError(e)) });
    }
  }

  const m = metrics.data;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{c.name}</Text>
        <Badge label={titleCase(c.status)} tone={CAMPAIGN_STATUS_TONE[c.status]} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {[c.sendPush ? 'Push' : null, c.sendEmail ? 'Email' : null].filter(Boolean).join(' + ') || 'No channel'} · {c.recipients} recipients
        {c.scheduledAt ? ` · scheduled ${formatDateTime(c.scheduledAt)}` : ''}
        {c.sentAt ? ` · sent ${formatDateTime(c.sentAt)}` : ''}
      </Text>

      {c.status === 'sent' && m ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
          <Metric label="Recipients" value={String(m.recipients)} />
          <Metric label="Push sent" value={`${m.push.sent}`} />
          <Metric label="Push opened" value={`${m.push.opened}`} tone="success" />
          <Metric label="Email sent" value={`${m.email.sent}`} />
          <Metric label="Email opened" value={`${m.email.opened}`} tone="success" />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {canEdit ? <Button label={editing ? 'Close' : 'Edit'} variant="secondary" onPress={() => setEditing((v) => !v)} /> : null}
        {canLifecycle ? <Button label="Test send" variant="secondary" onPress={() => action.mutate({ id: c.id, action: 'test' }, { onError: (e) => Alert.alert('Test failed', apiError(e)) })} /> : null}
        {canLifecycle ? <Button label="Send" onPress={onSend} /> : null}
        {canCancel ? <Button label="Cancel" variant="secondary" tone="danger" onPress={onCancel} /> : null}
        {canDelete ? <Button label="Delete" variant="secondary" tone="danger" onPress={onDelete} /> : null}
      </View>

      {editing && canEdit ? (
        <View style={{ marginTop: 12 }}>
          <CampaignForm existing={c} onDone={() => setEditing(false)} />
        </View>
      ) : null}
    </Card>
  );
}

// Campaign.segment is a JSON string on the wire; parse it (tolerant) for the pre-send preview.
function parseSegmentSafe(c: Campaign) {
  return parseSegment(c.segment);
}
```

Add `parseSegment` to the `@tesserix/homechef-shared` import at the top:

```tsx
import { formatDateTime, parseSegment, titleCase, type Campaign } from '@tesserix/homechef-shared';
```

- [ ] **Step 3: Run the gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/app/homechef/campaigns.tsx
git commit -m "feat(mobile): homechef campaigns screen (list/status-actions/metrics/send)"
```

---

## Task 7: Flip hub rows live + final gate

**Files:**
- Modify: `apps/mobile/app/homechef/index.tsx:36,39`

**Interfaces:**
- Consumes: the two route files created in Tasks 4 and 6 (`/homechef/promos`, `/homechef/campaigns`).
- Produces: Campaigns and Promos are reachable from the HomeChef hub Marketing group.

- [ ] **Step 1: Flip both Marketing rows to live**

In `apps/mobile/app/homechef/index.tsx`, in the `Marketing` group:

Change:
```tsx
    { title: 'Campaigns', sub: 'Push/email blasts', icon: Megaphone, route: '/homechef/campaigns', live: false },
```
to:
```tsx
    { title: 'Campaigns', sub: 'Push/email blasts', icon: Megaphone, route: '/homechef/campaigns', live: true },
```

Change:
```tsx
    { title: 'Promos', sub: 'Discount codes', icon: TicketPercent, route: '/homechef/promos', live: false },
```
to:
```tsx
    { title: 'Promos', sub: 'Discount codes', icon: TicketPercent, route: '/homechef/promos', live: true },
```

- [ ] **Step 2: Run the full gate**

Run: `pnpm --filter @tesserix/homechef-shared build && cd apps/mobile && npx tsc --noEmit`
Expected: 0 errors across the whole app.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/homechef/index.tsx
git commit -m "feat(mobile): homechef hub — Campaigns + Promos live (H5 Part 2 complete)"
```

---

## Self-Review Notes

- **Spec coverage:** Campaigns list/compose/preview/schedule/send/test/cancel/delete + metrics → Tasks 1, 5, 6. Promos create(13)/edit(8)/deactivate/reactivate + search + per-code analytics → Tasks 2, 3, 4. Hub wiring → Task 7. Winback/Loyalty already shipped (H5 Part 1) — out of scope here.
- **Immutability:** Edit form derives its PUT body from a `useMemo` `base` and spreads `{ ...base, ...patch }`; no in-place mutation.
- **Type consistency:** `useCreateCampaign` typed `hc.post<Campaign>` so `onSuccess(c)` gives `c.id`; `CampaignInput` used verbatim as the write body; `PromoCreateBody`/`PromoUpdateBody` are the only numeric wire bodies and are consumed by exactly the form components that build them; `FilterChips<T extends string>` is reused for every single-select (discount/funding/applicable/recency/subscription/chef id).
- **Known deferrals (parity-accurate, match web):** `EditForm` cannot change `validUntil` (no edit path in web either); ISO-text datetime entry instead of a native picker (per spec "keep it simple"); no bulk campaign send on mobile.
- **Money review weight:** promo funding guard (chef-funded requires chefId) and the irreversible campaign send (fresh-preview-before-confirm) are the two money/blast-sensitive paths — flag for extra reviewer attention.
