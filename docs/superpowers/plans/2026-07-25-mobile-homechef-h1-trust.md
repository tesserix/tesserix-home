# Mobile HomeChef — Sub-slice H1: Trust & Moderation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the web admin's Chefs & Trust area (minus Chefs, already live) into the mobile app — Approvals (list + detail with decide actions), Reviews moderation, FSSAI lockouts — plus a reusable PromptSheet primitive, and flip the three hub rows live.

**Architecture:** expo-router screens under `apps/mobile/app/homechef/`, backed by hooks added to the existing `apps/mobile/lib/hooks.ts` (the `hc` HMAC gateway client). A new `apps/mobile/components/prompt.tsx` provides an imperative `useConfirm()` (`confirm`/`prompt`) via a single app-level Modal, mounted in the root layout. Reason/note/days collection goes through it. No backend or shared-package changes.

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, `@tesserix/homechef-shared` (wire types + formatters), kit in `apps/mobile/components/kit.tsx`, theme in `apps/mobile/lib/theme.ts`.

## Global Constraints

- **No RN unit-test runner.** The only gate is typecheck: `pnpm --filter @tesserix/homechef-shared build` (once, to refresh dist so `tsc` sees the format/contract exports) then `cd apps/mobile && npx tsc --noEmit` — must be clean. Every task's final step is this gate + a commit.
- All HomeChef calls go through the `hc` client (`apps/mobile/lib/api.ts`): `hc.get<T>(path, params?)` (params → querystring), `hc.post<T>(path, body?)`, `hc.put<T>(path, body?)`, `hc.del<T>(path)` (no body). All return `Promise<T>` (unwrapped). Errors surfaced with `apiError(e)` from `lib/api`.
- **Palette has NO `danger` key.** The destructive color is `p.destructive` (`+ destructiveBg/destructiveFg`). The kit `Tone` union (`Badge`/`Banner`) *does* include `'danger'` (it maps internally to `destructiveBg/Fg`) — so `<Badge tone="danger" />` is correct, but any raw palette color for destructive UI is `p.destructive`. The kit `Button` destructive prop is `tone="danger"`.
- `reviewedBy`, `ApprovalHistoryEntry`, and `BackfillResponse`/`BackfillChef` are **NOT** in `@tesserix/homechef-shared` — declare them locally (exported from `lib/hooks.ts`, per Task 2). `ApprovalRequest`, `ReviewRow`, `FSSAILockResponse`/`FSSAILockedChef`, `Paginated<T>`, and formatters ARE in the shared package.
- Wire dates are ISO **strings**. Money is not involved in this slice.
- Forward-ref routes (list → detail before the detail file exists in a task) use `router.push('/homechef/approvals/' + id as never)` (codebase convention for expo-router typedRoutes).
- List+detail uses the **folder** convention: `approvals/index.tsx` (the `/homechef/approvals` route) + `approvals/[id].tsx`. Do NOT create `approvals.tsx`.
- Match existing screen conventions (see `app/homechef/chefs.tsx`, `cancellations.tsx`): `Screen` + `ScreenHeader` with a back `ChevronLeft`, `FilterChips`, `SearchField`, `ListRow`, `Badge`, `Banner`, `EmptyState`, `LoadingRows`, `Button`; theme tokens `usePalette`/`space`/`radius`/`text`; local `StyleSheet` for bespoke cards/inputs.
- Commit messages: conventional, single-line, no signatures. Commit directly to `main`.

## Smoke-test harness (controller — user's step, not the implementer's)

Metro on 8082; dev build; sign-in is user-driven. Deep-link a screen: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///homechef/reviews"`. Screenshot: `xcrun simctl io AD109A46-2F99-43C3-8AAA-FEE68DC8499E screenshot <path>`. Implementers do NOT run the sim; they gate on `tsc`.

## File structure

- **Create** `apps/mobile/components/prompt.tsx` — `PromptProvider` + `useConfirm()` (confirm/prompt). (Task 1)
- **Modify** `apps/mobile/app/_layout.tsx` — mount `<PromptProvider>` around `<Gate />`. (Task 1)
- **Modify** `apps/mobile/lib/hooks.ts` — local types + new hooks + doc-open helper + `useApprovals` param widening. (Task 2)
- **Create** `apps/mobile/app/homechef/reviews.tsx` — Reviews moderation. (Task 3)
- **Create** `apps/mobile/app/homechef/fssai.tsx` — FSSAI lockouts. (Task 4)
- **Create** `apps/mobile/app/homechef/approvals/index.tsx` — Approvals list. (Task 5)
- **Create** `apps/mobile/app/homechef/approvals/[id].tsx` — Approval detail + decide. (Task 6)
- **Modify** `apps/mobile/app/homechef/index.tsx` — flip Approvals/Reviews/FSSAI `live:true`. (Task 7)

---

## Task 1: PromptSheet primitive + provider

**Files:**
- Create: `apps/mobile/components/prompt.tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Produces: `PromptProvider` (component), `useConfirm(): { confirm(opts: ConfirmOptions): Promise<boolean>; prompt(opts: PromptOptions): Promise<string | null> }`. `ConfirmOptions = { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'destructive' }`. `PromptOptions = ConfirmOptions & { label?: string; placeholder?: string; defaultValue?: string; multiline?: boolean; required?: boolean; minLength?: number; numeric?: boolean }`. `prompt` resolves the trimmed string, or `null` on cancel. `confirm` resolves `true`/`false`.

- [ ] **Step 1: Create the prompt primitive**

Create `apps/mobile/components/prompt.tsx`:
```tsx
// prompt.tsx — an imperative confirm/prompt over a single app-level Modal, the
// native twin of the web `useConfirm` (confirm-dialog). Mount <PromptProvider>
// once above the navigator; call useConfirm().confirm / .prompt from any screen.
import {
  createContext, useCallback, useContext, useMemo, useState, type ReactNode,
} from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { radius, space, text, usePalette } from '../lib/theme';
import { Button } from './kit';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
}
export interface PromptOptions extends ConfirmOptions {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  required?: boolean;
  minLength?: number;
  numeric?: boolean;
}

interface PromptApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}
interface Pending {
  kind: 'confirm' | 'prompt';
  opts: PromptOptions;
  resolve: (v: boolean | string | null) => void;
}

const Ctx = createContext<PromptApi | null>(null);

export function useConfirm(): PromptApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useConfirm must be used within <PromptProvider>');
  return api;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const p = usePalette();
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setValue('');
        setError(null);
        setPending({ kind: 'confirm', opts, resolve: resolve as Pending['resolve'] });
      }),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? '');
        setError(null);
        setPending({ kind: 'prompt', opts, resolve: resolve as Pending['resolve'] });
      }),
    [],
  );
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  function close(result: boolean | string | null) {
    pending?.resolve(result);
    setPending(null);
    setValue('');
    setError(null);
  }
  function onCancel() {
    if (pending) close(pending.kind === 'confirm' ? false : null);
  }
  function onConfirm() {
    if (!pending) return;
    if (pending.kind === 'confirm') {
      close(true);
      return;
    }
    const o = pending.opts;
    const trimmed = value.trim();
    if (o.required && trimmed.length === 0) return setError('This field is required.');
    if (o.minLength && trimmed.length < o.minLength)
      return setError(`Enter at least ${o.minLength} characters.`);
    if (o.numeric && !/^\d+$/.test(trimmed)) return setError('Enter a number.');
    close(trimmed);
  }

  const o = pending?.opts;
  const destructive = o?.tone === 'destructive';

  return (
    <Ctx.Provider value={api}>
      {children}
      <Modal visible={!!pending} transparent animationType="fade" onRequestClose={onCancel}>
        <Pressable style={styles.backdrop} onPress={onCancel}>
          <Pressable
            style={[styles.sheet, { backgroundColor: p.elevated, borderColor: p.border }]}
            onPress={() => {}}
          >
            {o ? (
              <>
                <Text style={[text.title, { color: p.foreground }]}>{o.title}</Text>
                {o.message ? (
                  <Text style={[text.body, { color: p.mutedForeground, marginTop: 6 }]}>{o.message}</Text>
                ) : null}
                {pending?.kind === 'prompt' ? (
                  <>
                    {o.label ? (
                      <Text style={[text.label, { color: p.foreground, marginTop: 14, marginBottom: 6 }]}>
                        {o.label}
                      </Text>
                    ) : null}
                    <TextInput
                      value={value}
                      onChangeText={(t) => {
                        setValue(t);
                        if (error) setError(null);
                      }}
                      placeholder={o.placeholder}
                      placeholderTextColor={p.mutedForeground}
                      multiline={o.multiline}
                      keyboardType={o.numeric ? 'number-pad' : 'default'}
                      autoFocus
                      style={[
                        styles.input,
                        o.multiline ? { minHeight: 88 } : null,
                        { borderColor: error ? p.destructive : p.border, color: p.foreground, backgroundColor: p.muted },
                      ]}
                    />
                    {error ? (
                      <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.destructive, marginTop: 6 }}>
                        {error}
                      </Text>
                    ) : null}
                  </>
                ) : null}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                  <View style={{ flex: 1 }}>
                    <Button label={o.cancelLabel ?? 'Cancel'} variant="secondary" onPress={onCancel} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={o.confirmLabel ?? 'Confirm'}
                      tone={destructive ? 'danger' : 'default'}
                      onPress={onConfirm}
                    />
                  </View>
                </View>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[5],
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space[5],
  },
  input: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'InterTight',
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
```

- [ ] **Step 2: Mount the provider in the root layout**

In `apps/mobile/app/_layout.tsx`, add the import and wrap `<Gate />` (inside `AuthProvider`, so the Modal sits above every screen):
```tsx
import { PromptProvider } from '../components/prompt';
```
Change the `AuthProvider` body from:
```tsx
        <AuthProvider>
          <StatusBar style="auto" />
          <Gate />
        </AuthProvider>
```
to:
```tsx
        <AuthProvider>
          <StatusBar style="auto" />
          <PromptProvider>
            <Gate />
          </PromptProvider>
        </AuthProvider>
```

- [ ] **Step 3: Gate + commit**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean (no errors). Then:
```bash
git add apps/mobile/components/prompt.tsx apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): reusable PromptSheet (useConfirm/prompt) + mount in root layout"
```

---

## Task 2: Data-layer additions (`lib/hooks.ts`)

**Files:**
- Modify: `apps/mobile/lib/hooks.ts`

**Interfaces:**
- Produces (exported from `lib/hooks.ts`): types `ReviewerRef`, `ApprovalDetail`, `ApprovalHistoryEntry`, `BackfillChef`, `BackfillResponse`; hooks `useApproval(id)`, `useApprovalHistory(id)`, `useEscalatedCount()`, `useDecideApproval(id)`, `useFssaiLocked()`, `useNotifyFssaiBackfill()`; helpers `openApprovalDocument(id, docId)`, `fetchFssaiBackfill()`; widened `useApprovals` params (`search`, `reminded`, `escalated`).
- Consumes: existing `hc`, `qk`, `useAdminAction`, `Paginated`, `ApprovalRequest` from this file / shared.

- [ ] **Step 1: Extend imports**

In `apps/mobile/lib/hooks.ts`, add `Linking` and `FSSAILockResponse`. At the top add:
```ts
import { Linking } from 'react-native';
```
Add `FSSAILockResponse` to the existing `@tesserix/homechef-shared` type import block (alongside `AdminStats`, `AdminAnalytics`, etc.):
```ts
  FSSAILockResponse,
```

- [ ] **Step 2: Add local wire types**

After the `import` block (before `export const qk`), add:
```ts
// These three shapes are returned by the HomeChef admin gateway but are NOT part
// of @tesserix/homechef-shared (the web pages declare them locally too). Keep them
// next to the hooks that produce them.
export interface ReviewerRef {
  firstName?: string;
  lastName?: string;
  email?: string;
}
export type ApprovalDetail = ApprovalRequest & { reviewedBy?: ReviewerRef | null };
export interface ApprovalHistoryEntry {
  id: string;
  fromStatus?: string;
  toStatus: string;
  notes?: string;
  createdAt: string;
  changedBy?: ReviewerRef | null;
}
export interface BackfillChef {
  chefId: string;
  userId: string;
  businessName: string;
}
export interface BackfillResponse {
  count: number;
  chefs: BackfillChef[];
  executed: boolean;
  notified: number;
}
```

- [ ] **Step 3: Extend `qk` and `useApprovals` params**

In the `qk` object, add these keys:
```ts
  approval: (id: string) => ['hc', 'approval', id] as const,
  approvalHistory: (id: string) => ['hc', 'approval-history', id] as const,
  fssaiLocked: ['hc', 'fssai-locked'] as const,
```
Replace the existing `useApprovals` definition:
```ts
export const useApprovals = (p: { status?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.approvals(p), queryFn: () => hc.get<Paginated<ApprovalRequest>>('/approvals', p) });
```
with (adds `search`, `reminded`, `escalated`):
```ts
export const useApprovals = (p: {
  status?: string;
  search?: string;
  reminded?: string;
  escalated?: string;
  page?: number;
  limit?: number;
}) =>
  useQuery({ queryKey: qk.approvals(p), queryFn: () => hc.get<Paginated<ApprovalRequest>>('/approvals', p) });
```

- [ ] **Step 4: Add the new hooks + helpers**

Append to `apps/mobile/lib/hooks.ts` (end of file):
```ts
// ---- Approvals detail + decide ---------------------------------------------
export const useApproval = (id: string) =>
  useQuery({
    queryKey: qk.approval(id),
    queryFn: () => hc.get<ApprovalDetail>(`/approvals/${id}`),
    enabled: !!id,
  });

export const useApprovalHistory = (id: string) =>
  useQuery({
    queryKey: qk.approvalHistory(id),
    queryFn: () => hc.get<{ data: ApprovalHistoryEntry[] }>(`/approvals/${id}/history`),
    enabled: !!id,
  });

// Badge the Escalated filter chip without loading the whole view: total only.
export const useEscalatedCount = () =>
  useQuery({
    queryKey: ['hc', 'approvals-escalated-count'] as const,
    queryFn: () => hc.get<Paginated<ApprovalRequest>>('/approvals', { escalated: 'true', page: 1, limit: 1 }),
    select: (d) => d.pagination.total,
  });

// approve | reject | request-info → PUT /approvals/:id/:action { notes }.
export function useDecideApproval(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { action: 'approve' | 'reject' | 'request-info'; notes: string }) =>
      hc.put(`/approvals/${id}/${a.action}`, { notes: a.notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hc', 'approvals'] });
      qc.invalidateQueries({ queryKey: qk.approval(id) });
      qc.invalidateQueries({ queryKey: qk.approvalHistory(id) });
    },
  });
}

// Documents live privately in GCS; fetch a short-lived signed URL on demand and
// open it in the system browser.
export async function openApprovalDocument(id: string, docId: string): Promise<void> {
  const { url } = await hc.get<{ url?: string }>(`/approvals/${id}/documents/${docId}`);
  if (!url) throw new Error('Document is not available.');
  await Linking.openURL(url);
}

// ---- FSSAI lockouts --------------------------------------------------------
export const useFssaiLocked = () =>
  useQuery({ queryKey: qk.fssaiLocked, queryFn: () => hc.get<FSSAILockResponse>('/chefs/fssai-locked') });

// Dry-run list of chefs missing an FSSAI expiry (button-triggered, not a query).
export const fetchFssaiBackfill = () => hc.get<BackfillResponse>('/fssai-expiry-backfill');

// Send the one-time confirm-licence push to those chefs.
export function useNotifyFssaiBackfill() {
  return useMutation({ mutationFn: () => hc.post<BackfillResponse>('/fssai-expiry-backfill') });
}
```
(Reviews hide/unhide and FSSAI override grant/clear reuse the existing `useAdminAction` from the screens — no new hooks needed.)

- [ ] **Step 5: Gate + commit**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/lib/hooks.ts
git commit -m "feat(mobile): homechef H1 hooks — approval detail/history/decide, doc open, fssai lockouts"
```

---

## Task 3: Reviews screen

**Files:**
- Create: `apps/mobile/app/homechef/reviews.tsx`

**Interfaces:**
- Consumes: `useReviews`, `useAdminAction`, `qk` (from `lib/hooks`); `useConfirm` (from `components/prompt`); `ReviewRow`, `formatDateTime` (shared); kit `Badge`/`Button`/etc.

- [ ] **Step 1: Create the Reviews screen**

Create `apps/mobile/app/homechef/reviews.tsx`:
```tsx
import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useReviews, useAdminAction } from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatDateTime, type ReviewRow } from '@tesserix/homechef-shared';
import {
  Badge, Button, Card, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const VIEWS = [
  { key: 'visible', label: 'Visible' },
  { key: 'hidden', label: 'Hidden' },
] as const;
type View = (typeof VIEWS)[number]['key'];

function ratingTone(r: number): Tone {
  if (r >= 4) return 'success';
  if (r >= 3) return 'warning';
  return 'danger';
}

export default function Reviews() {
  const p = usePalette();
  const [view, setView] = useState<View>('visible');
  const q = useReviews({ hidden: view === 'hidden' ? 'true' : '', page: 1, limit: 50 });
  const action = useAdminAction(['hc', 'reviews']);
  const { prompt } = useConfirm();
  const rows = q.data?.data ?? [];

  async function hide(r: ReviewRow) {
    const reason = await prompt({
      title: 'Hide review',
      message: "This hides the review from the chef's page. The reason is kept for audit.",
      label: 'Reason',
      placeholder: 'e.g. abusive language / spam',
      multiline: true,
      required: true,
      confirmLabel: 'Hide review',
      tone: 'destructive',
    });
    if (reason === null) return;
    action.mutate(
      { method: 'put', path: `/reviews/${r.id}/hide`, body: { reason } },
      { onError: (e) => Alert.alert('Could not hide', apiError(e)) },
    );
  }
  function unhide(r: ReviewRow) {
    action.mutate(
      { method: 'put', path: `/reviews/${r.id}/unhide` },
      { onError: (e) => Alert.alert('Could not unhide', apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="Reviews"
        subtitle={q.data ? `${q.data.pagination.total} ${view}` : 'Moderation'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={VIEWS as unknown as { key: View; label: string }[]} value={view} onChange={setView} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="No reviews" body="Nothing in this view." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 12, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => {
            const busy = action.isPending;
            return (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Badge label={`${item.overallRating?.toFixed(1) ?? '0.0'}★`} tone={ratingTone(item.overallRating)} />
                  <Text style={[text.caption, { color: p.mutedForeground }]}>{formatDateTime(item.createdAt)}</Text>
                </View>
                <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{item.comment || 'No comment'}</Text>
                {item.isHidden && item.hiddenReason ? (
                  <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: p.destructive, marginTop: 8 }}>
                    Hidden: {item.hiddenReason}
                  </Text>
                ) : null}
                <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                  {item.isHidden ? (
                    <Button label="Unhide review" variant="secondary" disabled={busy} onPress={() => unhide(item)} />
                  ) : (
                    <Button label="Hide review" variant="secondary" tone="danger" disabled={busy} onPress={() => hide(item)} />
                  )}
                </View>
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}
```
Note: `Text` is imported from `react-native` — add it to the RN import: `import { Alert, FlatList, Pressable, Text, View } from 'react-native';`.

- [ ] **Step 2: Gate + commit**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/reviews.tsx
git commit -m "feat(mobile): homechef reviews moderation (hide/unhide)"
```

---

## Task 4: FSSAI screen

**Files:**
- Create: `apps/mobile/app/homechef/fssai.tsx`

**Interfaces:**
- Consumes: `useFssaiLocked`, `useNotifyFssaiBackfill`, `fetchFssaiBackfill`, `useAdminAction`, `qk`, `BackfillChef` (from `lib/hooks`); `useConfirm` (prompt/confirm); `FSSAILockedChef`, `formatDate` (shared).

- [ ] **Step 1: Create the FSSAI screen**

Create `apps/mobile/app/homechef/fssai.tsx`:
```tsx
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import {
  useFssaiLocked, useNotifyFssaiBackfill, fetchFssaiBackfill, useAdminAction, type BackfillChef,
} from '../../lib/hooks';
import { apiError } from '../../lib/api';
import { useConfirm } from '../../components/prompt';
import { formatDate, type FSSAILockedChef } from '@tesserix/homechef-shared';
import {
  Badge, Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel,
} from '../../components/kit';
import { usePalette, space, radius, text } from '../../lib/theme';

export default function Fssai() {
  const p = usePalette();
  const q = useFssaiLocked();
  const notify = useNotifyFssaiBackfill();
  const override = useAdminAction(['hc', 'fssai-locked']);
  const { confirm, prompt } = useConfirm();

  const [notice, setNotice] = useState<string | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfill, setBackfill] = useState<BackfillChef[] | null>(null);
  const [backfillLoading, setBackfillLoading] = useState(false);

  const data = q.data;

  async function viewBackfill() {
    if (backfillOpen) {
      setBackfillOpen(false);
      return;
    }
    setBackfillOpen(true);
    if (backfill) return;
    setBackfillLoading(true);
    try {
      const res = await fetchFssaiBackfill();
      setBackfill(res.chefs);
    } catch (e) {
      Alert.alert('Could not load list', apiError(e));
      setBackfillOpen(false);
    } finally {
      setBackfillLoading(false);
    }
  }
  async function notifyBackfill() {
    const ok = await confirm({
      title: 'Send confirm-licence push',
      message: 'Send a one-time push asking every chef with a missing FSSAI expiry to confirm their licence?',
      confirmLabel: 'Send push',
    });
    if (!ok) return;
    setNotice(null);
    notify.mutate(undefined, {
      onSuccess: (res) => {
        setBackfill(res.chefs);
        setNotice(`Confirm-licence push sent to ${res.notified} chef(s).`);
      },
      onError: (e) => Alert.alert('Notify failed', apiError(e)),
    });
  }

  async function grant(ch: FSSAILockedChef) {
    const reason = await prompt({
      title: `Grant FSSAI override — ${ch.businessName}`,
      message: 'Temporarily lift the FSSAI lock so this kitchen can keep operating.',
      label: 'Reason (min 10 characters)',
      placeholder: 'Why is this override justified?',
      multiline: true,
      required: true,
      minLength: 10,
      confirmLabel: 'Next',
    });
    if (reason === null) return;
    const daysStr = await prompt({
      title: 'Override duration',
      message: 'How long should the override last?',
      label: 'Days (1–30)',
      placeholder: '7',
      defaultValue: '7',
      numeric: true,
      required: true,
      confirmLabel: 'Grant override',
    });
    if (daysStr === null) return;
    const days = Number(daysStr);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      Alert.alert('Invalid duration', 'Days must be a whole number between 1 and 30.');
      return;
    }
    override.mutate(
      { method: 'post', path: `/chefs/${ch.chefId}/fssai-override`, body: { reason, days } },
      { onError: (e) => Alert.alert('Override failed', apiError(e)) },
    );
  }
  async function clear(ch: FSSAILockedChef) {
    const ok = await confirm({
      title: 'Clear override',
      message: `Re-lock ${ch.businessName}? It will be blocked until its FSSAI licence is renewed.`,
      confirmLabel: 'Clear override',
      tone: 'destructive',
    });
    if (!ok) return;
    override.mutate(
      { method: 'del', path: `/chefs/${ch.chefId}/fssai-override` },
      { onError: (e) => Alert.alert('Clear failed', apiError(e)) },
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="FSSAI Lockouts"
        subtitle={data ? `${data.lockedCount} locked · ${data.overriddenCount} overridden` : 'Expired licences'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      {notice ? <Banner text={notice} tone="success" /> : null}
      {q.isLoading || !data ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}
        >
          {data.missingExpiryCount > 0 ? (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text style={[text.caption, { color: p.mutedForeground, flex: 1 }]}>
                  {data.missingExpiryCount} chef(s) have no FSSAI expiry on record.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button label={backfillOpen ? 'Hide' : 'View'} variant="secondary" onPress={viewBackfill} />
                  <Button label={notify.isPending ? 'Notifying…' : 'Notify'} disabled={notify.isPending} onPress={notifyBackfill} />
                </View>
              </View>
              {backfillOpen ? (
                backfillLoading ? (
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 10 }]}>Loading…</Text>
                ) : backfill && backfill.length > 0 ? (
                  <View style={{ marginTop: 10, gap: 4 }}>
                    {backfill.map((ch) => (
                      <Text key={ch.chefId} style={[text.body, { color: p.foreground }]}>{ch.businessName}</Text>
                    ))}
                  </View>
                ) : (
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 10 }]}>
                    No chefs pending an expiry confirmation.
                  </Text>
                )
              ) : null}
            </Card>
          ) : null}

          <View>
            <SectionLabel>Locked ({data.lockedCount})</SectionLabel>
            {data.locked.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>None locked.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {data.locked.map((ch) => (
                  <View key={ch.chefId} style={[styles.row, { borderColor: p.border, backgroundColor: p.surface }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]}>{ch.businessName}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        Expiry {ch.fssaiExpiry ? formatDate(ch.fssaiExpiry) : 'unknown'} · {ch.daysSinceExpiry}d expired
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Badge label="Locked" tone="danger" />
                      <Button label="Grant override" variant="secondary" disabled={override.isPending} onPress={() => grant(ch)} />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View>
            <SectionLabel>Overridden ({data.overriddenCount})</SectionLabel>
            {data.overridden.length === 0 ? (
              <Text style={[text.caption, { color: p.mutedForeground }]}>No active overrides.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {data.overridden.map((ch) => (
                  <View key={ch.chefId} style={[styles.row, { borderColor: p.border, backgroundColor: p.surface }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[text.title, { color: p.foreground }]}>{ch.businessName}</Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        Until {ch.overrideUntil ? formatDate(ch.overrideUntil) : '—'}
                        {ch.overrideReason ? ` · ${ch.overrideReason}` : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 8 }}>
                      <Badge label="Override active" tone="info" />
                      <Button label="Clear" variant="secondary" tone="danger" disabled={override.isPending} onPress={() => clear(ch)} />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
```

- [ ] **Step 2: Gate + commit**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/fssai.tsx
git commit -m "feat(mobile): homechef FSSAI lockouts (override grant/clear + expiry backfill)"
```

---

## Task 5: Approvals list

**Files:**
- Create: `apps/mobile/app/homechef/approvals/index.tsx`

**Interfaces:**
- Consumes: `useApprovals`, `useEscalatedCount` (from `lib/hooks`); `ApprovalRequest`, `ApprovalPriority`, `titleCase`, `formatDateTime`, `formatRelative` (shared); kit.
- Produces: the `/homechef/approvals` route. (Detail route `/homechef/approvals/[id]` is built in Task 6; deep-link uses `as never`.)

- [ ] **Step 1: Create the Approvals list**

Create `apps/mobile/app/homechef/approvals/index.tsx`:
```tsx
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BellRing, ChevronLeft } from 'lucide-react-native';
import { useApprovals, useEscalatedCount } from '../../../lib/hooks';
import { titleCase, formatDateTime, formatRelative, type ApprovalPriority, type ApprovalRequest } from '@tesserix/homechef-shared';
import {
  Badge, EmptyState, FilterChips, LoadingRows, Screen, ScreenHeader, SearchField, type Tone,
} from '../../../components/kit';
import { usePalette, space, radius, text } from '../../../lib/theme';

// Filter keys — the 4 review states plus the two chase cross-cuts.
type Filter = 'pending' | 'info_requested' | 'approved' | 'rejected' | 'reminded' | 'escalated';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'info_requested', label: 'Info requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'reminded', label: 'Reminded' },
  { key: 'escalated', label: 'Escalated' },
];

function priorityTone(p: ApprovalPriority): Tone {
  if (p === 'urgent') return 'danger';
  if (p === 'high') return 'warning';
  if (p === 'low') return 'neutral';
  return 'info';
}

// Reminder urgency from chase count: 1 = amber, 2 = purple, ≥3 = escalated (bell).
type ReminderTone = 'none' | 'amber' | 'purple' | 'red';
function reminderLevel(n: number | null | undefined): { tone: ReminderTone; showBell: boolean } {
  const c = n ?? 0;
  if (c >= 3) return { tone: 'red', showBell: true };
  if (c === 2) return { tone: 'purple', showBell: false };
  if (c === 1) return { tone: 'amber', showBell: false };
  return { tone: 'none', showBell: false };
}
const ACCENT: Record<ReminderTone, string | undefined> = {
  none: undefined,
  amber: '#F59E0B',
  purple: '#A855F7',
  red: '#DC2626',
};

// How long a request has waited, phrased for triage.
function waitedFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3_600_000);
  return `${Math.max(hrs, 0)}h`;
}

function listParams(filter: Filter, search: string) {
  const s = search.trim() || undefined;
  if (filter === 'escalated') return { escalated: 'true', search: s, page: 1, limit: 50 };
  if (filter === 'reminded') return { reminded: 'true', search: s, page: 1, limit: 50 };
  return { status: filter, search: s, page: 1, limit: 50 };
}

export default function ApprovalsList() {
  const p = usePalette();
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const q = useApprovals(listParams(filter, search));
  const escalated = useEscalatedCount();
  const rows = q.data?.data ?? [];

  const chips = FILTERS.map((f) =>
    f.key === 'escalated' && (escalated.data ?? 0) > 0
      ? { key: f.key, label: `${f.label} (${escalated.data})` }
      : f,
  );

  return (
    <Screen>
      <ScreenHeader
        title="Approvals"
        subtitle={q.data ? `${q.data.pagination.total} ${filter === 'escalated' || filter === 'reminded' ? filter : titleCase(filter)}` : 'Review queue'}
        right={
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
            <ChevronLeft size={24} color={p.mutedForeground} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <SearchField value={search} onChangeText={setSearch} placeholder="Search title or description" />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={chips} value={filter} onChange={setFilter} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filter === 'escalated' ? 'Nothing escalated' : 'Nothing here'}
          body={filter === 'escalated' ? 'Nobody is waiting on us.' : 'Nothing in this state.'}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <ApprovalRow a={item} />}
        />
      )}
    </Screen>
  );
}

function ApprovalRow({ a }: { a: ApprovalRequest }) {
  const p = usePalette();
  const level = reminderLevel(a.reminderCount);
  const accent = ACCENT[level.tone];
  const escalated = level.tone === 'red' || Boolean(a.escalatedAt);
  const sub = [a.kitchenName, a.requestedByName].filter(Boolean).join(' · ');
  const reminderLabel =
    (a.reminderCount ?? 0) > 0
      ? `${escalated ? 'Escalated' : `Reminded ×${a.reminderCount}`}${a.lastRemindedAt ? ` · ${formatRelative(a.lastRemindedAt)}` : ''}`
      : null;

  return (
    <Pressable
      onPress={() => router.push(('/homechef/approvals/' + a.id) as never)}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: p.border,
          backgroundColor: pressed ? p.muted : p.surface,
          borderLeftWidth: accent ? 3 : StyleSheet.hairlineWidth,
          borderLeftColor: accent ?? p.border,
        },
      ]}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {level.showBell ? <BellRing size={15} color="#DC2626" /> : null}
          <Text style={[text.title, { color: p.foreground, flexShrink: 1 }]} numberOfLines={1}>
            {a.title || titleCase(a.type)}
          </Text>
        </View>
        {sub ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{sub}</Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <Badge label={titleCase(a.priority)} tone={priorityTone(a.priority)} />
          <Text style={[text.caption, { color: p.mutedForeground }]}>{titleCase(a.type)}</Text>
        </View>
        {reminderLabel ? (
          <Text style={{ fontFamily: 'InterTight-Medium', fontSize: 12, color: accent ?? p.mutedForeground, marginTop: 6 }}>
            {reminderLabel} · waiting {waitedFor(a.createdAt)}
          </Text>
        ) : null}
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]}>{formatDateTime(a.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: space[4],
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
```

- [ ] **Step 2: Gate + commit**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean (the `as never` cast lets the not-yet-existing detail route typecheck). Then:
```bash
git add apps/mobile/app/homechef/approvals/index.tsx
git commit -m "feat(mobile): homechef approvals queue (status + reminded/escalated filters)"
```

---

## Task 6: Approval detail + decide

**Files:**
- Create: `apps/mobile/app/homechef/approvals/[id].tsx`

**Interfaces:**
- Consumes: `useApproval`, `useApprovalHistory`, `useDecideApproval`, `openApprovalDocument`, `ReviewerRef` (from `lib/hooks`); `useConfirm` (from `components/prompt`); `ApprovalRequest`, `titleCase`, `formatDateTime` (shared); kit.

- [ ] **Step 1: Create the Approval detail screen**

Create `apps/mobile/app/homechef/approvals/[id].tsx`:
```tsx
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import {
  useApproval, useApprovalHistory, useDecideApproval, openApprovalDocument, type ReviewerRef,
} from '../../../lib/hooks';
import { apiError } from '../../../lib/api';
import { useConfirm } from '../../../components/prompt';
import { titleCase, formatDateTime } from '@tesserix/homechef-shared';
import {
  Badge, Banner, Button, Card, LoadingRows, Screen, ScreenHeader, SectionLabel, type Tone,
} from '../../../components/kit';
import { usePalette, space, radius, text } from '../../../lib/theme';

function statusTone(s: string): Tone {
  if (s === 'approved') return 'success';
  if (s === 'rejected') return 'danger';
  return 'warning';
}
function personName(r: ReviewerRef | null | undefined): string {
  if (!r) return '';
  const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
  return name || r.email || '';
}
// submittedData may arrive as a raw JSON *string*; normalize to an object so we
// don't render a character grid.
function asObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}
function renderValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(', ');
    return v.map((x) => renderValue(x)).join('; ');
  }
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val != null && val !== '')
      .map(([k, val]) => `${titleCase(k)}: ${renderValue(val)}`);
    return parts.length > 0 ? parts.join(' · ') : '—';
  }
  return String(v);
}

function Field({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={{ minWidth: 120, flexGrow: 1, flexBasis: '40%' }}>
      <Text style={[text.caption, { color: p.mutedForeground }]}>{label}</Text>
      <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

export default function ApprovalDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useApproval(id);
  const historyQ = useApprovalHistory(id);
  const decide = useDecideApproval(id);
  const { confirm, prompt } = useConfirm();
  const [docBusy, setDocBusy] = useState<string | null>(null);

  const a = q.data;
  const history = historyQ.data?.data ?? [];

  async function openDoc(docId: string) {
    setDocBusy(docId);
    try {
      await openApprovalDocument(id, docId);
    } catch (e) {
      Alert.alert('Could not open document', apiError(e));
    } finally {
      setDocBusy(null);
    }
  }

  async function act(action: 'approve' | 'reject' | 'request-info') {
    let notes = '';
    if (action === 'approve') {
      const ok = await confirm({
        title: 'Approve request',
        message: 'Approve this request? This triggers the related workflow.',
        confirmLabel: 'Approve',
      });
      if (!ok) return;
    } else {
      const r = await prompt({
        title: action === 'reject' ? 'Reject request' : 'Request more info',
        message:
          action === 'reject'
            ? 'Add a note explaining the rejection (shared with the applicant).'
            : "Tell the applicant what's missing.",
        label: 'Note',
        placeholder: action === 'reject' ? 'Reason for rejection…' : 'What do you need?',
        multiline: true,
        required: true,
        confirmLabel: action === 'reject' ? 'Reject' : 'Send request',
        tone: action === 'reject' ? 'destructive' : 'default',
      });
      if (r === null) return;
      notes = r;
    }
    decide.mutate({ action, notes }, { onError: (e) => Alert.alert('Action failed', apiError(e)) });
  }

  const back = (
    <Pressable onPress={() => router.back()} hitSlop={10} style={{ paddingTop: 4 }}>
      <ChevronLeft size={24} color={p.mutedForeground} />
    </Pressable>
  );

  if (q.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Approval" right={back} />
        <LoadingRows />
      </Screen>
    );
  }
  if (!a) {
    return (
      <Screen>
        <ScreenHeader title="Approval" right={back} />
        <Text style={[text.body, { color: p.mutedForeground, padding: space[4] }]}>Request not found.</Text>
      </Screen>
    );
  }

  const submitted = Object.entries(asObject(a.submittedData));
  const pending = a.status === 'pending' || a.status === 'info_requested';

  return (
    <Screen>
      <ScreenHeader title={a.title || titleCase(a.type)} subtitle={titleCase(a.type)} right={back} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
        <View style={{ alignSelf: 'flex-start' }}>
          <Badge label={titleCase(a.status)} tone={statusTone(a.status)} />
        </View>

        {a.kitchenTypeNonHome ? (
          <Banner text="Submitted kitchen type is NOT a home kitchen — HomeChef onboards home cooks only." />
        ) : null}
        {a.fssaiLooksCommercial ? (
          <Banner text="FSSAI licence looks like a commercial (State/Central) registration — verify this is a home kitchen." />
        ) : null}

        {a.description ? <Text style={[text.body, { color: p.foreground }]}>{a.description}</Text> : null}

        <Card>
          <View style={styles.grid}>
            {a.kitchenName ? <Field label="Kitchen" value={a.kitchenName} /> : null}
            {a.requestedByName || a.requestedByEmail ? (
              <Field label="Requested by" value={a.requestedByName || a.requestedByEmail || '—'} />
            ) : null}
            <Field label="Priority" value={titleCase(a.priority)} />
            <Field label="Submitted" value={formatDateTime(a.createdAt)} />
            {a.reviewedAt ? <Field label="Reviewed" value={formatDateTime(a.reviewedAt)} /> : null}
            {personName(a.reviewedBy) ? <Field label="Reviewed by" value={personName(a.reviewedBy)} /> : null}
          </View>
          {a.adminNotes ? (
            <View style={{ marginTop: 12 }}>
              <Text style={[text.caption, { color: p.mutedForeground }]}>Admin notes</Text>
              <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{a.adminNotes}</Text>
            </View>
          ) : null}
        </Card>

        {submitted.length > 0 ? (
          <View>
            <SectionLabel>Submitted details</SectionLabel>
            <Card>
              <View style={{ gap: 12 }}>
                {submitted.map(([k, v]) => (
                  <View key={k}>
                    <Text style={[text.caption, { color: p.mutedForeground }]}>{titleCase(k)}</Text>
                    <Text style={[text.body, { color: p.foreground, marginTop: 2 }]}>{renderValue(v)}</Text>
                  </View>
                ))}
              </View>
            </Card>
          </View>
        ) : null}

        {a.documents && a.documents.length > 0 ? (
          <View>
            <SectionLabel>Documents ({a.documents.length})</SectionLabel>
            <Card>
              <View style={{ gap: 12 }}>
                {a.documents.map((d) => (
                  <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={[text.body, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
                      {titleCase(d.type ?? 'Document')}{d.fileName ? ` · ${d.fileName}` : ''}
                    </Text>
                    <Button
                      label={docBusy === d.id ? 'Opening…' : 'View'}
                      variant="secondary"
                      disabled={docBusy === d.id}
                      onPress={() => openDoc(d.id)}
                    />
                  </View>
                ))}
              </View>
            </Card>
          </View>
        ) : null}

        {history.length > 0 ? (
          <View>
            <SectionLabel>History</SectionLabel>
            <Card>
              <View style={{ gap: 12 }}>
                {history.map((h) => {
                  const actor = personName(h.changedBy);
                  return (
                    <View key={h.id} style={{ borderLeftWidth: 2, borderLeftColor: p.border, paddingLeft: 10 }}>
                      <Text style={[text.title, { color: p.foreground }]}>
                        {h.fromStatus ? `${titleCase(h.fromStatus)} → ` : ''}{titleCase(h.toStatus)}
                      </Text>
                      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]}>
                        {formatDateTime(h.createdAt)}{actor ? ` · ${actor}` : ''}
                      </Text>
                      {h.notes ? <Text style={[text.body, { color: p.foreground, marginTop: 4 }]}>{h.notes}</Text> : null}
                    </View>
                  );
                })}
              </View>
            </Card>
          </View>
        ) : null}

        {pending ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <View style={{ flexGrow: 1, flexBasis: '30%' }}>
              <Button label="Approve" disabled={decide.isPending} onPress={() => act('approve')} />
            </View>
            <View style={{ flexGrow: 1, flexBasis: '30%' }}>
              <Button label="Request info" variant="secondary" disabled={decide.isPending} onPress={() => act('request-info')} />
            </View>
            <View style={{ flexGrow: 1, flexBasis: '30%' }}>
              <Button label="Reject" variant="secondary" tone="danger" disabled={decide.isPending} onPress={() => act('reject')} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
});
```

- [ ] **Step 2: Gate + commit**

Run:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean. Then:
```bash
git add apps/mobile/app/homechef/approvals/[id].tsx
git commit -m "feat(mobile): homechef approval detail — submission, docs, history, decide"
```

---

## Task 7: Hub wiring + final gate

**Files:**
- Modify: `apps/mobile/app/homechef/index.tsx`

**Interfaces:**
- Consumes: the three routes built in Tasks 3–6.

- [ ] **Step 1: Flip the three hub rows live**

In `apps/mobile/app/homechef/index.tsx`, in the `SECTIONS` array, change `live: false` → `live: true` on exactly these three rows (leave every other row unchanged):
- `Approvals` (Operations group): `{ title: 'Approvals', sub: 'Onboarding queue', icon: ClipboardCheck, route: '/homechef/approvals', live: true },`
- `FSSAI` (Operations group): `{ title: 'FSSAI', sub: 'License compliance locks', icon: ShieldCheck, route: '/homechef/fssai', live: true },`
- `Reviews` (People & quality group): `{ title: 'Reviews', sub: 'Moderate ratings', icon: Star, route: '/homechef/reviews', live: true },`

- [ ] **Step 2: Full-slice gate + commit**

Run the full gate one more time:
```bash
pnpm --filter @tesserix/homechef-shared build
cd apps/mobile && npx tsc --noEmit
```
Expected: clean across the whole slice. Then:
```bash
git add apps/mobile/app/homechef/index.tsx
git commit -m "feat(mobile): homechef hub — Approvals, FSSAI, Reviews live"
```

---

## Self-review (completed during authoring)

- **Spec coverage:** Approvals list (T5), Approval detail incl. warnings/submitted-data/documents/history/decide (T6), Reviews hide/unhide (T3), FSSAI locked/overridden/backfill (T4), PromptSheet primitive (T1), hooks incl. `reminded`/`escalated` params + escalated count + doc open (T2), hub flag flips (T7). Bulk-approve intentionally omitted (v1 decision). All spec screens covered.
- **Placeholder scan:** no TBD/TODO; every step carries full code or an exact edit.
- **Type consistency:** `useDecideApproval(id)` mutate arg `{ action, notes }` matches T6 call sites; `useAdminAction` arg `{ method: 'put'|'post'|'del', path, body? }` matches T3/T4 call sites; `openApprovalDocument(id, docId)` signature matches T6; `useConfirm().prompt` returns `string | null` and `confirm` returns `boolean`, matching all call sites; palette destructive uses `p.destructive`, kit tones use `'danger'`. `useEscalatedCount` `select` → `number`, consumed as `escalated.data ?? 0`.
- **Route convention:** `approvals/index.tsx` + `approvals/[id].tsx` (folder), forward-ref deep-link cast `as never` in T5 before T6 exists.
