# Mobile Mark8ly Slice A — Hub + Lifecycle Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mark8ly product section into the Expo mobile admin — a hub, Overview, Leads (list + detail with status/star/activity/send-email actions), Tenants (list + status-change + read-only detail).

**Architecture:** expo-router screens under `apps/mobile/app/mark8ly/`, mirroring the HomeChef product-hub pattern and the Platform screens. Each screen is backed by TanStack Query hooks in a new `lib/mark8ly-hooks.ts` calling existing web `/api/admin/*` routes via the `plat` client, with response types in a new `lib/mark8ly-contracts.ts`. `product=mark8ly` is hardcoded in product-scoped paths. No backend changes; no `plat` client changes.

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, axios (`plat` client), `@tesserix/homechef-shared` formatters, kit in `apps/mobile/components/kit.tsx`.

## Global Constraints

- Metro on **port 8082** (`RCT_METRO_PORT=8082 npx expo start --dev-client --port 8082`); 8081 is taken by Docker. Dev build required.
- `EXPO_PUBLIC_API_BASE=https://tesserix.app` (never `home.tesserix.app`).
- All new calls use the existing `plat` client (`apps/mobile/lib/api.ts`) — prefixes `/api/admin`, adds bearer + `Origin` (so CSRF-checked mutations pass). **No `plat` client changes.**
- **No RN unit-test runner exists.** Per-task gate: `cd apps/mobile && npx tsc --noEmit` clean **and** a controller sim smoke test. If tsc reports missing `@tesserix/homechef-shared` exports, run `pnpm --filter @tesserix/homechef-shared build` from repo root first. Do not add a test framework.
- Wire dates are **ISO strings** (server row types say `Date` but JSON-serialize to string) — declare contract fields as `string`.
- Reuse `LeadStatus` (`'new'|'contacted'|'qualified'|'converted'|'lost'`) already exported from `lib/platform-contracts.ts`. Reuse `useLeadTemplates` + `LeadTemplate`/`LeadTemplatesResponse` from `platform-hooks.ts`/`platform-contracts.ts`.
- Match sibling conventions: kit from `../../components/kit` (or `../../../` for nested `[id].tsx`), theme from `lib/theme` (`usePalette`, `space`, `radius`, `text`), formatters (`titleCase`, `formatRelative`, `formatDateTime`, `formatCount`, `formatRatioPct`) from `@tesserix/homechef-shared`. Text inputs use a local `StyleSheet` like `platform/announcements.tsx`. Errors surfaced via `Alert.alert('…', apiError(e))`.
- Commit messages: conventional, single-line, no signatures.

## Smoke-test harness (controller, each task)

Metro on 8082; the app is a dev build. To reach a screen, sign in then navigate via **Apps → Mark8ly** (after Task 6), or deep-link before nav exists:
```bash
xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///mark8ly/overview"
```
Screenshot: `xcrun simctl io AD109A46-2F99-43C3-8AAA-FEE68DC8499E screenshot /tmp/shot.png`. (Auth session may need a fresh Google login — user-driven.)

---

## Task 1: Overview screen + data-layer bootstrap

Creates `mark8ly-contracts.ts` + `mark8ly-hooks.ts` and the Overview screen.

**Files:**
- Create: `apps/mobile/lib/mark8ly-contracts.ts`
- Create: `apps/mobile/lib/mark8ly-hooks.ts`
- Create: `apps/mobile/app/mark8ly/overview.tsx`

**Interfaces:**
- Consumes: `plat`; `usePlatformDashboard` (from `platform-hooks.ts`), `PlatformDashboard` (from `platform-contracts.ts`).
- Produces: `mk` key factory; `useRevenue(days?)` → `UseQueryResult<RevenueData>`; `useCriticalCount()` → `UseQueryResult<Mark8lyCriticalSummary>`. `RevenueData`, `Mark8lyCriticalSummary` types.

- [ ] **Step 1: Create the contracts file**

Create `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// Response shapes for Mark8ly product-admin routes: /api/admin/* (tenants, leads)
// and the product-scoped /api/admin/apps/mark8ly/*. Mirrors the web handlers;
// wire dates are ISO strings (server row types use Date). Extra fields ignored.

// ---- Overview: revenue + critical count ------------------------------------
export interface RevenueData {
  currency: string;
  mrr: number;
  arr: number;
  newTrials30d: number;
  cancelled30d: number;
  churnRate: number; // 0..1 ratio
  activeCount: number;
  generatedAt: string;
}
export interface Mark8lyCriticalSummary {
  summary: { criticalLast24h: number };
}
```

- [ ] **Step 2: Create the hooks file**

Create `apps/mobile/lib/mark8ly-hooks.ts`:
```ts
// mark8ly-hooks.ts — TanStack Query hooks over Mark8ly's /api/admin routes via
// the `plat` client. product='mark8ly' is a hardcoded path segment on the
// product-scoped routes. Mutations invalidate their list/detail keys.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plat } from './api';
import type { RevenueData, Mark8lyCriticalSummary } from './mark8ly-contracts';

const PRODUCT = 'mark8ly';

export const mk = {
  revenue: (days: number) => ['mk', 'revenue', days] as const,
  critical: ['mk', 'critical'] as const,
  leads: (p: object) => ['mk', 'leads', p] as const,
  leadActivities: (id: string) => ['mk', 'lead-activities', id] as const,
  tenants: (status: string) => ['mk', 'tenants', status] as const,
  tenant: (id: string) => ['mk', 'tenant', id] as const,
  tenantBilling: (id: string) => ['mk', 'tenant-billing', id] as const,
};

// ---- Overview ---------------------------------------------------------------
export const useRevenue = (days = 30) =>
  useQuery({ queryKey: mk.revenue(days), queryFn: () => plat.get<RevenueData>(`/apps/${PRODUCT}/revenue`, { days }) });

export const useCriticalCount = () =>
  useQuery({
    queryKey: mk.critical,
    queryFn: () => plat.get<Mark8lyCriticalSummary>(`/apps/${PRODUCT}/audit-logs`, { severity: 'critical', since_hours: 24 }),
  });
```
Note: `useMutation`/`useQueryClient` are imported now (unused until Task 3) — that's fine, no `noUnusedLocals`. If a strict lint objects, the later tasks use them.

- [ ] **Step 3: Create the Overview screen**

Create `apps/mobile/app/mark8ly/overview.tsx`:
```tsx
// Mark8ly overview — scalar revenue + business KPIs (no sparklines/cost).
import { RefreshControl, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { usePlatformDashboard } from '../../lib/platform-hooks';
import { useRevenue, useCriticalCount } from '../../lib/mark8ly-hooks';
import { formatCount, formatRatioPct } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, StatGrid, StatTile, SectionLabel, LoadingRows,
} from '../../components/kit';
import { space } from '../../lib/theme';

function money(currency: string, n: number): string {
  return `${currency} ${formatCount(n)}`;
}

export default function Mark8lyOverview() {
  const dash = usePlatformDashboard();
  const rev = useRevenue(30);
  const crit = useCriticalCount();
  const r = rev.data;
  const d = dash.data;
  const refreshing = rev.isRefetching || dash.isRefetching || crit.isRefetching;
  const refetchAll = () => { rev.refetch(); dash.refetch(); crit.refetch(); };

  return (
    <Screen>
      <ScreenHeader title="Mark8ly" subtitle="Overview" right={<BackButton onPress={() => router.back()} />} />
      {rev.isLoading && dash.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
        >
          <SectionLabel>Revenue</SectionLabel>
          <StatGrid>
            <StatTile label="MRR" value={r ? money(r.currency, r.mrr) : '—'} />
            <StatTile label="ARR" value={r ? money(r.currency, r.arr) : '—'} />
            <StatTile label="Trials 30d" value={r ? formatCount(r.newTrials30d) : '—'} />
            <StatTile label="Churn" value={r ? formatRatioPct(r.churnRate) : '—'} tone={r && r.churnRate > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Active subs" value={r ? formatCount(r.activeCount) : '—'} />
          </StatGrid>

          <SectionLabel>Business</SectionLabel>
          <StatGrid>
            <StatTile label="Active tenants" value={d ? formatCount(d.tenants.active) : '—'} />
            <StatTile label="Stores" value={d ? formatCount(d.stores.total) : '—'} />
            <StatTile label="Leads" value={d ? formatCount(d.leads.total) : '—'} />
            <StatTile
              label="Critical 24h"
              value={crit.data ? formatCount(crit.data.summary.criticalLast24h) : '—'}
              tone={crit.data && crit.data.summary.criticalLast24h > 0 ? 'danger' : 'neutral'}
            />
          </StatGrid>
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Smoke test (controller)**

Deep-link `tesserix-admin:///mark8ly/overview`. Expect revenue + business KPI tiles populated with real numbers. No red-box. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/overview.tsx
git commit -m "feat(mobile): mark8ly overview screen + data-layer bootstrap"
```

---

## Task 2: Leads list screen

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `Lead`, `LeadsResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `useLeads`)
- Create: `apps/mobile/app/mark8ly/leads/index.tsx`

**Interfaces:**
- Produces: `Lead`, `LeadsResponse` types; `useLeads(filters: { status?: string; q?: string; starred?: boolean })` → `UseQueryResult<LeadsResponse>`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Leads -----------------------------------------------------------------
import type { LeadStatus } from './platform-contracts';

export interface Lead {
  id: string;
  email: string | null;
  instagram_handle: string | null;
  phone: string | null;
  name: string | null;
  company: string | null;
  location: string | null;
  category: string[];
  has_website: boolean | null;
  website_url: string | null;
  biography: string | null;
  tags: string[];
  followers_count: number | null;
  posts_count: number | null;
  is_starred: boolean;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  owner: string | null;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  activity_count?: number;
}
export interface LeadsResponse {
  leads: Lead[];
}
```
(Move the `import type { LeadStatus }` to the top of the file with the other imports if the linter prefers; a mid-file `import type` is valid TS but hoist it for cleanliness.)

- [ ] **Step 2: Add the hook**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `Lead, LeadsResponse` to the contracts import, and add:
```ts
// ---- Leads ------------------------------------------------------------------
export const useLeads = (filters: { status?: string; q?: string; starred?: boolean }) =>
  useQuery({
    queryKey: mk.leads(filters),
    queryFn: () =>
      plat.get<LeadsResponse>('/leads', {
        status: filters.status && filters.status !== 'all' ? filters.status : undefined,
        q: filters.q || undefined,
        starred: filters.starred ? 'true' : undefined,
      }),
  });
```

- [ ] **Step 3: Create the leads list screen**

Create `apps/mobile/app/mark8ly/leads/index.tsx`:
```tsx
// Mark8ly leads — CRM list with search + status/starred filters.
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Star } from 'lucide-react-native';
import { useLeads } from '../../../lib/mark8ly-hooks';
import type { Lead } from '../../../lib/mark8ly-contracts';
import type { LeadStatus } from '../../../lib/platform-contracts';
import { formatRelative, titleCase, formatCount } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, SearchField, FilterChips,
  EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

const STATUS_OPTS = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'converted', label: 'Converted' },
  { key: 'lost', label: 'Lost' },
];

const STATUS_TONE: Record<LeadStatus, Tone> = {
  new: 'info',
  contacted: 'warning',
  qualified: 'info',
  converted: 'success',
  lost: 'neutral',
};

function leadName(l: Lead): string {
  return l.name || l.company || l.instagram_handle || l.email || 'Unknown lead';
}

export default function Leads() {
  const p = usePalette();
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [starred, setStarred] = useState(false);
  const query = useLeads({ status, q, starred });
  const leads = query.data?.leads ?? [];

  return (
    <Screen>
      <ScreenHeader title="Leads" subtitle="Mark8ly CRM" right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], gap: 8, paddingBottom: 8 }}>
        <SearchField value={q} onChangeText={setQ} placeholder="Search leads…" />
        <FilterChips options={STATUS_OPTS} value={status} onChange={setStatus} />
        <FilterChips options={[{ key: 'off', label: 'All' }, { key: 'on', label: '★ Starred' }]} value={starred ? 'on' : 'off'} onChange={(k) => setStarred(k === 'on')} />
      </View>
      {query.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(l) => l.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={query.isRefetching}
          onRefresh={() => query.refetch()}
          ListEmptyComponent={<EmptyState title="No leads" body="No leads match this filter." />}
          renderItem={({ item }) => (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {item.is_starred ? <Star size={14} color={p.warning} fill={p.warning} /> : null}
                <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1} onPress={() => router.push(`/mark8ly/leads/${item.id}`)}>
                  {leadName(item)}
                </Text>
                <Badge label={titleCase(item.status)} tone={STATUS_TONE[item.status]} />
              </View>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1} onPress={() => router.push(`/mark8ly/leads/${item.id}`)}>
                {[item.email, item.instagram_handle, item.location].filter(Boolean).join(' · ') || '—'}
              </Text>
              <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
                {[item.owner ? `owner ${item.owner}` : null, item.activity_count != null ? `${formatCount(item.activity_count)} activities` : null, formatRelative(item.created_at)].filter(Boolean).join(' · ')}
              </Text>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
```
Note: `Card` isn't tappable itself; the title/subtitle `Text` carry `onPress` to open the detail (kit `Card` has no `onPress` prop). This is intentional and matches how tap targets are added when a whole `Card` must open a route.

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.

- [ ] **Step 5: Smoke test (controller)** — from the app, deep-link `tesserix-admin:///mark8ly/leads`. Expect a lead list; search + status chips + starred toggle filter it; tapping a lead navigates (detail arrives in Task 3 — until then the route 404s, which is expected). Screenshot.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/leads/index.tsx
git commit -m "feat(mobile): mark8ly leads list with search + filters"
```

---

## Task 3: Lead detail screen (status / star / activity / send-email)

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `LeadActivity`, `LeadActivitiesResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `useLeadActivities`, `useSetLeadStatus`, `useToggleLeadStar`, `useLogLeadActivity`, `useSendLeadEmail`)
- Create: `apps/mobile/app/mark8ly/leads/[id].tsx`

**Interfaces:**
- Consumes: `useLeads` (Task 2, to source the lead from cache), `useLeadTemplates` (from `platform-hooks.ts`), `apiError` (from `api.ts`).
- Produces: `LeadActivity`, `LeadActivitiesResponse`; the five hooks above.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Lead activities --------------------------------------------------------
export type LeadActivityKind =
  | 'note' | 'dm_sent' | 'dm_received' | 'email_sent' | 'email_received'
  | 'call' | 'status_change' | 'assigned';

export interface LeadActivity {
  id: string;
  lead_id: string;
  kind: LeadActivityKind;
  actor_email: string;
  body: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface LeadActivitiesResponse {
  activities: LeadActivity[];
}
```

- [ ] **Step 2: Add hooks**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `LeadActivitiesResponse` to the contracts import, `import type { LeadStatus } from './platform-contracts';`, and add:
```ts
// ---- Lead detail actions ----------------------------------------------------
export const useLeadActivities = (id: string) =>
  useQuery({
    queryKey: mk.leadActivities(id),
    queryFn: () => plat.get<LeadActivitiesResponse>(`/leads/${id}/activities`),
    enabled: !!id,
  });

export function useSetLeadStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: LeadStatus) => plat.patch<{ lead: unknown }>(`/leads/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mk', 'leads'] });
      qc.invalidateQueries({ queryKey: mk.leadActivities(id) });
    },
  });
}

export function useToggleLeadStar(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (is_starred: boolean) => plat.patch<{ lead: unknown }>(`/leads/${id}`, { is_starred }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mk', 'leads'] }),
  });
}

export function useLogLeadActivity(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: string; body: string }) => plat.post<{ activity: unknown }>(`/leads/${id}/activities`, a),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mk.leadActivities(id) });
      qc.invalidateQueries({ queryKey: ['mk', 'leads'] });
    },
  });
}

export function useSendLeadEmail(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateKey: string) =>
      plat.post<{ sent: true; recipient: string; messageId: string }>(`/leads/${id}/send-email`, {
        templateKey,
        idempotencyKey: `lead-${id}-${templateKey}-${Date.now()}`,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mk.leadActivities(id) });
      qc.invalidateQueries({ queryKey: ['mk', 'leads'] });
    },
  });
}
```

- [ ] **Step 3: Create the lead detail screen**

Create `apps/mobile/app/mark8ly/leads/[id].tsx`:
```tsx
// Lead detail — status/star/activity/send-email. Lead sourced from the leads
// list cache (no GET /leads/{id} exists); activities fetched separately.
import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Star } from 'lucide-react-native';
import { useLeads, useLeadActivities, useSetLeadStatus, useToggleLeadStar, useLogLeadActivity, useSendLeadEmail } from '../../../lib/mark8ly-hooks';
import { useLeadTemplates } from '../../../lib/platform-hooks';
import type { LeadActivity } from '../../../lib/mark8ly-contracts';
import type { LeadStatus } from '../../../lib/platform-contracts';
import { apiError } from '../../../lib/api';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, FilterChips, SectionLabel,
  EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, radius, space, text } from '../../../lib/theme';

const STATUS_OPTS: { key: LeadStatus; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'converted', label: 'Converted' },
  { key: 'lost', label: 'Lost' },
];

const ACTIVITY_TONE: Record<LeadActivity['kind'], Tone> = {
  note: 'neutral', dm_sent: 'info', dm_received: 'info', email_sent: 'info',
  email_received: 'info', call: 'success', status_change: 'warning', assigned: 'warning',
};

export default function LeadDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  // No GET /leads/{id}; find the lead in the (unfiltered) leads cache/fetch.
  const list = useLeads({});
  const lead = useMemo(() => list.data?.leads.find((l) => l.id === id), [list.data, id]);
  const activities = useLeadActivities(id ?? '');
  const setStatus = useSetLeadStatus(id ?? '');
  const toggleStar = useToggleLeadStar(id ?? '');
  const logActivity = useLogLeadActivity(id ?? '');
  const sendEmail = useSendLeadEmail(id ?? '');
  const templates = useLeadTemplates();

  const [note, setNote] = useState('');

  if (list.isLoading) return <Screen><ScreenHeader title="Lead" right={<BackButton onPress={() => router.back()} />} /><LoadingRows /></Screen>;
  if (!lead) return <Screen><ScreenHeader title="Lead" right={<BackButton onPress={() => router.back()} />} /><Card><EmptyState title="Lead not found" body="Open it from the leads list." /></Card></Screen>;

  const displayName = lead.name || lead.company || lead.instagram_handle || lead.email || 'Lead';

  function addNote() {
    if (!note.trim()) return;
    logActivity.mutate({ kind: 'note', body: note.trim() }, {
      onSuccess: () => setNote(''),
      onError: (e) => Alert.alert('Could not log', apiError(e)),
    });
  }

  function pickTemplateAndSend() {
    const published = (templates.data?.templates ?? []).filter((t) => t.status === 'published');
    if (!lead.email) { Alert.alert('No email', 'This lead has no email address.'); return; }
    if (published.length === 0) { Alert.alert('No templates', 'No published templates to send.'); return; }
    Alert.alert('Send test email', `Pick a template to send to ${lead.email}`, [
      ...published.slice(0, 8).map((t) => ({
        text: t.label,
        onPress: () => sendEmail.mutate(t.key, {
          onSuccess: (r) => Alert.alert('Sent', `Email sent to ${r.recipient}.`),
          onError: (e) => Alert.alert('Send failed', apiError(e)),
        }),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }

  return (
    <Screen>
      <ScreenHeader title={displayName} subtitle={lead.email ?? lead.instagram_handle ?? undefined} right={<BackButton onPress={() => router.back()} />} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={80}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[text.label, { color: p.mutedForeground, flex: 1 }]}>Status</Text>
              <Button
                label={lead.is_starred ? '★ Starred' : '☆ Star'}
                variant="ghost"
                loading={toggleStar.isPending}
                onPress={() => toggleStar.mutate(!lead.is_starred, { onError: (e) => Alert.alert('Failed', apiError(e)) })}
              />
            </View>
            <View style={{ marginTop: 8 }}>
              <FilterChips
                options={STATUS_OPTS}
                value={lead.status}
                onChange={(s) => setStatus.mutate(s, { onError: (e) => Alert.alert('Failed', apiError(e)) })}
              />
            </View>
            <View style={{ marginTop: 12 }}>
              <Button label="Send email" variant="secondary" loading={sendEmail.isPending} onPress={pickTemplateAndSend} />
            </View>
          </Card>

          <View>
            <SectionLabel>Log a note</SectionLabel>
            <Card>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a note…"
                placeholderTextColor={p.mutedForeground}
                multiline
                style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
              />
              <View style={{ marginTop: 8 }}>
                <Button label="Add note" onPress={addNote} loading={logActivity.isPending} disabled={!note.trim() || logActivity.isPending} />
              </View>
            </Card>
          </View>

          <View>
            <SectionLabel>Activity</SectionLabel>
            {activities.isLoading ? (
              <LoadingRows rows={3} />
            ) : (activities.data?.activities ?? []).length === 0 ? (
              <Card><EmptyState title="No activity" body="No logged activity yet." /></Card>
            ) : (
              <View style={{ gap: 8 }}>
                {(activities.data?.activities ?? []).map((a) => (
                  <Card key={a.id}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Badge label={titleCase(a.kind)} tone={ACTIVITY_TONE[a.kind]} />
                      <View style={{ flex: 1 }} />
                      <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(a.created_at)}</Text>
                    </View>
                    {a.body ? <Text style={[text.body, { color: p.foreground, marginTop: 8 }]}>{a.body}</Text> : null}
                    <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>{a.actor_email}</Text>
                  </Card>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 72,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    textAlignVertical: 'top',
    fontFamily: 'InterTight',
    fontSize: 15,
  },
});
```
Note: the template picker uses `Alert.alert` with per-template buttons (capped at 8) — the simplest native picker without a new modal component; `lead.status` drives the status `FilterChips` selected value, and changing it fires the PATCH immediately.

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.

- [ ] **Step 5: Smoke test (controller)** — open a lead from the list. Expect: identity header, status chips (tap changes status → list reflects it), star toggle, a note composer (add → appears in Activity), Send-email (pick a template → "Sent" alert). Screenshot.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/leads/
git commit -m "feat(mobile): mark8ly lead detail — status/star/activity/send-email"
```

---

## Task 4: Tenants list screen (+ status change)

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `Tenant`, `TenantStatus`, `TenantsResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `useTenants`, `useSetTenantStatus`)
- Create: `apps/mobile/app/mark8ly/tenants/index.tsx`

**Interfaces:**
- Produces: `Tenant`, `TenantStatus`, `TenantsResponse`; `useTenants(status)`, `useSetTenantStatus(id)`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Tenants ----------------------------------------------------------------
export type TenantStatus = 'active' | 'suspended' | 'archived';
export interface Tenant {
  id: string;
  name: string;
  owner_user_id: string;
  owner_email: string;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
}
export interface TenantsResponse {
  tenants: Tenant[];
}
```

- [ ] **Step 2: Add hooks**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `Tenant, TenantsResponse, TenantStatus` to the contracts import, and add:
```ts
// ---- Tenants ----------------------------------------------------------------
export const useTenants = (status: string) =>
  useQuery({
    queryKey: mk.tenants(status),
    queryFn: () => plat.get<TenantsResponse>('/tenants', { status: status !== 'all' ? status : undefined }),
  });

export function useSetTenantStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: TenantStatus) => plat.patch<{ tenant: unknown }>(`/tenants/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mk', 'tenants'] });
      qc.invalidateQueries({ queryKey: mk.tenant(id) });
    },
  });
}
```

- [ ] **Step 3: Create the tenants list screen**

Create `apps/mobile/app/mark8ly/tenants/index.tsx`:
```tsx
// Mark8ly tenants — list + status change (active/suspended/archived).
import { useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTenants, useSetTenantStatus } from '../../../lib/mark8ly-hooks';
import type { Tenant, TenantStatus } from '../../../lib/mark8ly-contracts';
import { apiError } from '../../../lib/api';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, FilterChips,
  EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

const STATUS_OPTS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'archived', label: 'Archived' },
];
const STATUS_TONE: Record<TenantStatus, Tone> = { active: 'success', suspended: 'warning', archived: 'neutral' };
const NEXT: Record<TenantStatus, { label: string; to: TenantStatus }[]> = {
  active: [{ label: 'Suspend', to: 'suspended' }, { label: 'Archive', to: 'archived' }],
  suspended: [{ label: 'Reactivate', to: 'active' }, { label: 'Archive', to: 'archived' }],
  archived: [{ label: 'Reactivate', to: 'active' }],
};

export default function Tenants() {
  const [status, setStatus] = useState('all');
  const query = useTenants(status);
  const tenants = query.data?.tenants ?? [];

  return (
    <Screen>
      <ScreenHeader title="Tenants" subtitle="Mark8ly stores" right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], paddingBottom: 8 }}>
        <FilterChips options={STATUS_OPTS} value={status} onChange={setStatus} />
      </View>
      {query.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={tenants}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={query.isRefetching}
          onRefresh={() => query.refetch()}
          ListEmptyComponent={<EmptyState title="No tenants" body="No tenants match this filter." />}
          renderItem={({ item }) => <TenantCard t={item} />}
        />
      )}
    </Screen>
  );
}

function TenantCard({ t }: { t: Tenant }) {
  const p = usePalette();
  const setTenantStatus = useSetTenantStatus(t.id);

  function change(to: TenantStatus, label: string) {
    Alert.alert(`${label} tenant?`, `${t.name} will be set to ${to}.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: label, style: to === 'active' ? 'default' : 'destructive', onPress: () => setTenantStatus.mutate(to, { onError: (e) => Alert.alert('Failed', apiError(e)) }) },
    ]);
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1} onPress={() => router.push(`/mark8ly/tenants/${t.id}`)}>
          {t.name}
        </Text>
        <Badge label={titleCase(t.status)} tone={STATUS_TONE[t.status]} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
        {t.owner_email} · {formatRelative(t.created_at)}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        {NEXT[t.status].map((n) => (
          <View key={n.to} style={{ flex: 1 }}>
            <Button label={n.label} variant="secondary" loading={setTenantStatus.isPending} onPress={() => change(n.to, n.label)} />
          </View>
        ))}
      </View>
    </Card>
  );
}
```

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.

- [ ] **Step 5: Smoke test (controller)** — deep-link `tesserix-admin:///mark8ly/tenants`. Expect tenant list + status chips; tapping Suspend/Archive/Reactivate shows a confirm → applies → list reflects new status/badge. Screenshot.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/tenants/index.tsx
git commit -m "feat(mobile): mark8ly tenants list with status change"
```

---

## Task 5: Tenant detail screen (read-only)

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `TenantBilling`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `useTenant`, `useTenantBilling`)
- Create: `apps/mobile/app/mark8ly/tenants/[id].tsx`

**Interfaces:**
- Produces: `TenantBilling`; `useTenant(id)`, `useTenantBilling(id)`.

- [ ] **Step 1: Add contract type**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Tenant billing (detail) ------------------------------------------------
export interface TenantBilling {
  subscription: {
    plan: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  synthesized: boolean;
  currency: string;
  trial: { daysRemaining: number | null; conversionLikelihood: 'low' | 'medium' | 'high' } | null;
  lifetimeRevenue: { amount: number; currency: string } | null;
  margin: { revenue: number; infraCost: number; margin: number; currency: string; inTrial: boolean; hasSubscription: boolean } | null;
  generatedAt: string;
}
export interface TenantDetailResponse {
  tenant: Tenant;
}
```

- [ ] **Step 2: Add hooks**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `TenantBilling, TenantDetailResponse` to the contracts import, and add:
```ts
// ---- Tenant detail ----------------------------------------------------------
export const useTenant = (id: string) =>
  useQuery({ queryKey: mk.tenant(id), queryFn: () => plat.get<TenantDetailResponse>(`/tenants/${id}`), enabled: !!id });

export const useTenantBilling = (id: string) =>
  useQuery({ queryKey: mk.tenantBilling(id), queryFn: () => plat.get<TenantBilling>(`/apps/${PRODUCT}/tenants/${id}/billing`), enabled: !!id });
```

- [ ] **Step 3: Create the tenant detail screen**

Create `apps/mobile/app/mark8ly/tenants/[id].tsx`:
```tsx
// Tenant detail (read-only) — identity + subscription/billing block.
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTenant, useTenantBilling } from '../../../lib/mark8ly-hooks';
import type { TenantStatus } from '../../../lib/mark8ly-contracts';
import { formatDateTime, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Metric, SectionLabel, EmptyState, LoadingRows, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

const STATUS_TONE: Record<TenantStatus, Tone> = { active: 'success', suspended: 'warning', archived: 'neutral' };

export default function TenantDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTenant(id ?? '');
  const b = useTenantBilling(id ?? '');
  const tenant = t.data?.tenant;
  const billing = b.data;

  return (
    <Screen>
      <ScreenHeader title={tenant?.name ?? 'Tenant'} subtitle={tenant?.owner_email} right={<BackButton onPress={() => router.back()} />} />
      {t.isLoading ? (
        <LoadingRows />
      ) : !tenant ? (
        <Card><EmptyState title="Tenant not found" /></Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: space[4] }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[text.title, { color: p.foreground, flex: 1 }]}>Identity</Text>
              <Badge label={titleCase(tenant.status)} tone={STATUS_TONE[tenant.status]} />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
              <Metric label="Owner" value={tenant.owner_email} />
              <Metric label="Created" value={formatRelative(tenant.created_at)} />
            </View>
            <Text style={[text.caption, { color: p.mutedForeground, marginTop: 8 }]} numberOfLines={1}>{tenant.id}</Text>
          </Card>

          <View>
            <SectionLabel>Subscription</SectionLabel>
            {b.isLoading ? (
              <LoadingRows rows={2} />
            ) : !billing || !billing.subscription ? (
              <Card><EmptyState title="No subscription" body={billing?.trial ? 'In trial.' : 'No active subscription.'} /></Card>
            ) : (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Badge label={billing.subscription.plan} tone="info" />
                  <Badge label={titleCase(billing.subscription.status)} tone={billing.subscription.status === 'active' ? 'success' : 'warning'} />
                  {billing.synthesized ? <Badge label="synthetic" tone="neutral" /> : null}
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
                  {billing.trial?.daysRemaining != null ? <Metric label="Trial days" value={String(billing.trial.daysRemaining)} /> : null}
                  {billing.lifetimeRevenue ? <Metric label="Lifetime rev" value={`${billing.lifetimeRevenue.currency} ${billing.lifetimeRevenue.amount}`} /> : null}
                  {billing.subscription.current_period_end ? <Metric label="Renews" value={formatDateTime(billing.subscription.current_period_end)} /> : null}
                  <Metric label="Cancels EOP" value={billing.subscription.cancel_at_period_end ? 'Yes' : 'No'} />
                </View>
              </Card>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.

- [ ] **Step 5: Smoke test (controller)** — from the tenants list, tap a tenant. Expect identity card + subscription block (plan/status/trial/lifetime revenue), or a clean "No subscription/In trial" empty state. Screenshot.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/tenants/[id].tsx
git commit -m "feat(mobile): mark8ly tenant detail (read-only billing)"
```

---

## Task 6: Mark8ly hub + Apps-tab wiring

**Files:**
- Create: `apps/mobile/app/mark8ly/_layout.tsx`
- Create: `apps/mobile/app/mark8ly/index.tsx`
- Modify: `apps/mobile/app/(tabs)/apps.tsx` (flip mark8ly → live)

**Interfaces:**
- Consumes: routes `/mark8ly/overview`, `/mark8ly/leads`, `/mark8ly/tenants` (Tasks 1–5).

- [ ] **Step 1: Create the layout**

Create `apps/mobile/app/mark8ly/_layout.tsx` (identical to homechef's):
```tsx
import { Stack } from 'expo-router';

export default function Mark8lyLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

- [ ] **Step 2: Create the hub**

Create `apps/mobile/app/mark8ly/index.tsx`:
```tsx
// Mark8ly product hub. Live routes land on real screens; Slice-B items are "Soon".
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { LayoutDashboard, Users, Store, CreditCard, Route, ScrollText, Mail } from 'lucide-react-native';
import { ListRow, Screen, ScreenHeader, SectionLabel, Badge, BackButton } from '../../components/kit';
import { space } from '../../lib/theme';

const SECTIONS = [
  { group: 'Overview', items: [
    { title: 'Overview', sub: 'Revenue + business KPIs', icon: LayoutDashboard, route: '/mark8ly/overview', live: true },
  ]},
  { group: 'Growth', items: [
    { title: 'Leads', sub: 'CRM — status, notes, email', icon: Users, route: '/mark8ly/leads', live: true },
    { title: 'Onboarding', sub: 'Signup funnel', icon: Route, route: '/mark8ly/onboarding', live: false },
  ]},
  { group: 'Tenants & billing', items: [
    { title: 'Tenants', sub: 'Stores — status management', icon: Store, route: '/mark8ly/tenants', live: true },
    { title: 'Subscriptions', sub: 'Plans + MRR', icon: CreditCard, route: '/mark8ly/subscriptions', live: false },
  ]},
  { group: 'Ops', items: [
    { title: 'Audit logs', sub: 'Admin trail', icon: ScrollText, route: '/mark8ly/audit-logs', live: false },
    { title: 'Email templates', sub: 'Notification templates', icon: Mail, route: '/mark8ly/templates', live: false },
  ]},
] as const;

export default function Mark8lyHub() {
  return (
    <Screen>
      <ScreenHeader title="Mark8ly" subtitle="Marketplace SaaS" right={<BackButton onPress={() => router.back()} />} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10] }}>
        {SECTIONS.map((sec) => (
          <View key={sec.group} style={{ marginTop: space[4] }}>
            <SectionLabel>{sec.group}</SectionLabel>
            <View style={{ gap: 8 }}>
              {sec.items.map((it) => (
                <ListRow
                  key={it.title}
                  title={it.title}
                  subtitle={it.sub}
                  icon={it.icon}
                  trailing={it.live ? undefined : <Badge label="Soon" tone="neutral" />}
                  onPress={it.live ? () => router.push(it.route as never) : undefined}
                />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
```

- [ ] **Step 3: Flip the Apps-tab entry to live**

In `apps/mobile/app/(tabs)/apps.tsx`, find the mark8ly product entry:
```tsx
{ key: 'mark8ly', title: 'Mark8ly', subtitle: 'Marketplace SaaS · multi-tenant', icon: Store, route: '/mark8ly', live: false },
```
Change `live: false` → `live: true`. Do not touch the HomeChef entry or any other line.

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.

- [ ] **Step 5: Smoke test (controller)** — reload app → Apps tab → Mark8ly is tappable (no "Soon") → hub shows Overview/Leads/Tenants live and Onboarding/Subscriptions/Audit/Templates as "Soon". Tap each live item → correct screen. Screenshot.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/app/mark8ly/_layout.tsx apps/mobile/app/mark8ly/index.tsx "apps/mobile/app/(tabs)/apps.tsx"
git commit -m "feat(mobile): mark8ly hub + Apps-tab entry live"
```

---

## Task 7: Final verification + push

- [ ] **Step 1: Typecheck + doctor**
```bash
cd apps/mobile && npx tsc --noEmit && npx expo-doctor
```
Expected: tsc clean; expo-doctor shows no NEW issues (pre-existing monorepo warnings acceptable).

- [ ] **Step 2: Full smoke pass** — sign in, walk Apps → Mark8ly → Overview, Leads (search/filter → detail → change status, star, add note, send email), Tenants (change status → confirm), Tenant detail. Confirm real data + each action works. Screenshot each.

- [ ] **Step 3: Push**
```bash
git push origin main
```
(Pushing `main` redeploys the web `company` image — mobile-only changes, harmless but cycles prod.)

---

## Self-review notes (spec coverage)

- Overview → Task 1. Leads list → Task 2. Lead detail (status/star/activity/send-email) → Task 3. Tenants list + status change → Task 4. Tenant detail → Task 5. Hub + Apps-tab → Task 6. Verification → Task 7.
- Data layer (`mark8ly-contracts.ts` + `mark8ly-hooks.ts`) built incrementally across Tasks 1–5; reuses `usePlatformDashboard`, `useLeadTemplates`, `LeadStatus`, `LeadTemplate`.
- Deferred per spec (NOT in plan): leads CSV import, wide table + multi-band filters, owner-assign; metrics sparklines/cost/margin/plan-history; Slice-B screens (subscriptions/onboarding/audit/templates) shown only as "Soon" hub stubs.
- `idempotencyKey` mirrors the web pattern `lead-${id}-${templateKey}-${Date.now()}` (no new dependency). No `GET /leads/{id}` → detail sources the lead from `useLeads({})` cache/fetch.
