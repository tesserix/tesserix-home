# Mobile Mark8ly Slice B — Reporting + Template Send-Test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 4 remaining Mark8ly screens — Subscriptions, Onboarding funnel, Audit logs (all read-only) and Email templates (read-only list + Send-test) — and flip them live in the hub.

**Architecture:** expo-router screens under `apps/mobile/app/mark8ly/`, backed by hooks added to the existing `lib/mark8ly-hooks.ts` (calling `/api/admin/*` via the `plat` client) with types in `lib/mark8ly-contracts.ts`. Mirrors Slice A. No backend/`plat` changes.

**Tech Stack:** Expo SDK 56 / RN 0.85.3, expo-router, TanStack Query v5, `@tesserix/homechef-shared` formatters, kit in `apps/mobile/components/kit.tsx`.

## Global Constraints

- Metro on **8082**; dev build; `EXPO_PUBLIC_API_BASE=https://tesserix.app`.
- All calls via the existing `plat` client (`/api/admin` prefix). `product='mark8ly'` hardcoded on `/apps/mark8ly/*` routes. **Endpoints 4 & 5 (email-templates) are FLAT** — `/email-templates`, not under `/apps/mark8ly/`.
- **`plat.post` has no params arg** — for the send-test POST, put `database` in the path query string: `plat.post(\`/email-templates/${key}/test-send?database=${database}\`, { to })`.
- Gate: `cd apps/mobile && npx tsc --noEmit` clean; **no RN unit-test runner** (controller smoke-tests on the sim). If tsc reports missing `@tesserix/homechef-shared` exports, run `pnpm --filter @tesserix/homechef-shared build` first. No test framework.
- Wire dates are ISO **strings**. Reuse `useAuth` (`lib/auth`) for the operator email seed on the template Send-test; `apiError` from `lib/api` for error alerts.
- The tenant detail route `/mark8ly/tenants/[id]` **already exists** (Slice A); still, use `router.push(\`/mark8ly/tenants/${id}\` as never)` for those deep-links (codebase convention, avoids any typedRoutes edge case).
- Match Slice A / Platform conventions: kit components, theme tokens (`usePalette`/`space`/`radius`/`text`), whole-card `Pressable` for tap targets, local `StyleSheet` for text inputs (like `leads/[id].tsx` / `platform/lead-templates.tsx`), FilterChips, StatGrid/StatTile.
- Commit messages: conventional, single-line, no signatures.

## Smoke-test harness (controller)

Metro on 8082, dev build (sign-in is user-driven). Deep-link a screen: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///mark8ly/subscriptions"`; screenshot with `xcrun simctl io ... screenshot`.

---

## Task 1: Subscriptions screen

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `SubscriptionRowItem`, `SubscriptionsListResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `mk.subscriptions`, `useSubscriptions`)
- Create: `apps/mobile/app/mark8ly/subscriptions.tsx`

**Interfaces:**
- Produces: `SubscriptionRowItem`, `SubscriptionsListResponse`; `useSubscriptions(filter: string)` → `UseQueryResult<SubscriptionsListResponse>`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Subscriptions ----------------------------------------------------------
export interface SubscriptionRowItem {
  tenantId: string;
  tenantName: string;
  plan: string;
  status: string;
  mrr: number;
  currency: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialDaysRemaining?: number | null;
  conversionLikelihood?: 'low' | 'medium' | 'high';
  dunningState?: 'retrying' | 'exhausted' | null;
}
export interface SubscriptionsListResponse {
  summary: {
    totalMrr: number;
    currency: string;
    activeCount: number;
    trialCount: number;
    pastDueCount: number;
    cancelledThisMonth: number;
  };
  rows: SubscriptionRowItem[];
  generatedAt: string;
}
```

- [ ] **Step 2: Add key + hook**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `SubscriptionsListResponse` to the contracts import, add key `subscriptions: (filter: string) => ['mk', 'subscriptions', filter] as const,` to `mk`, and add:
```ts
// ---- Subscriptions ----------------------------------------------------------
export const useSubscriptions = (filter: string) =>
  useQuery({
    queryKey: mk.subscriptions(filter),
    queryFn: () => plat.get<SubscriptionsListResponse>(`/apps/${PRODUCT}/subscriptions`, { filter: filter !== 'all' ? filter : undefined }),
  });
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/mark8ly/subscriptions.tsx`:
```tsx
// Mark8ly subscriptions — MRR summary + per-subscription list (read-only).
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSubscriptions } from '../../lib/mark8ly-hooks';
import type { SubscriptionRowItem } from '../../lib/mark8ly-contracts';
import { formatCount, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, StatGrid, StatTile, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'trial', label: 'Trial' },
  { key: 'past_due', label: 'Past due' },
  { key: 'cancelled', label: 'Cancelled' },
];

function statusTone(s: string): Tone {
  if (s === 'active') return 'success';
  if (s === 'trialing') return 'info';
  if (s === 'past_due' || s === 'incomplete' || s === 'unpaid') return 'warning';
  if (s === 'canceled') return 'neutral';
  return 'neutral';
}

function money(currency: string, n: number): string {
  return `${currency} ${formatCount(n)}`;
}

export default function Subscriptions() {
  const [filter, setFilter] = useState('all');
  const q = useSubscriptions(filter);
  const rows = q.data?.rows ?? [];
  const s = q.data?.summary;

  return (
    <Screen>
      <ScreenHeader title="Subscriptions" subtitle="Mark8ly billing" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.tenantId}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3], paddingBottom: 8 }}>
              {q.isError ? <Banner text="Could not load subscriptions." tone="danger" /> : null}
              {s ? (
                <StatGrid>
                  <StatTile label="Total MRR" value={money(s.currency, s.totalMrr)} />
                  <StatTile label="Active" value={formatCount(s.activeCount)} tone="success" />
                  <StatTile label="Trial" value={formatCount(s.trialCount)} />
                  <StatTile label="Past due" value={formatCount(s.pastDueCount)} tone={s.pastDueCount > 0 ? 'warning' : 'neutral'} />
                  <StatTile label="Cancelled" value={formatCount(s.cancelledThisMonth)} />
                </StatGrid>
              ) : null}
              <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No subscriptions" body="Nothing matches this filter." />}
          renderItem={({ item }) => <SubCard r={item} />}
        />
      )}
    </Screen>
  );
}

function SubCard({ r }: { r: SubscriptionRowItem }) {
  const p = usePalette();
  return (
    <Pressable onPress={() => router.push(`/mark8ly/tenants/${r.tenantId}` as never)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{r.tenantName}</Text>
          <Badge label={titleCase(r.status)} tone={statusTone(r.status)} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <Badge label={r.plan} tone="info" />
          <Text style={[text.mono, { color: p.mutedForeground, flex: 1, textAlign: 'right' }]}>{money(r.currency, r.mrr)}</Text>
        </View>
        {r.dunningState || r.trialDaysRemaining != null ? (
          <Text style={[text.caption, { color: p.mutedForeground, marginTop: 6 }]} numberOfLines={1}>
            {[r.trialDaysRemaining != null ? `${r.trialDaysRemaining} trial days` : null, r.dunningState ? `dunning: ${r.dunningState}` : null].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}
```

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.
- [ ] **Step 5: Smoke test (controller)** — deep-link `tesserix-admin:///mark8ly/subscriptions`. Expect summary tiles + filter chips + subscription cards; tap a card → tenant detail. Screenshot.
- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/subscriptions.tsx
git commit -m "feat(mobile): mark8ly subscriptions screen"
```

---

## Task 2: Onboarding funnel screen

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `OnboardingSessionRow`, `OnboardingFunnelStats`, `OnboardingResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `mk.onboarding`, `useOnboarding`)
- Create: `apps/mobile/app/mark8ly/onboarding.tsx`

**Interfaces:**
- Produces: the 3 types; `useOnboarding(status: string)` → `UseQueryResult<OnboardingResponse>`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Onboarding funnel ------------------------------------------------------
export interface OnboardingFunnelStats {
  totalStarted: number;
  emailVerified: number;
  completed: number;
  inFlight: number;
  abandoned: number;
  medianTimeToCompleteSeconds: number | null;
  last24h: { started: number; completed: number };
}
export interface OnboardingSessionRow {
  id: string;
  email: string;
  business_name: string | null;
  status: string;
  email_verified_at: string | null;
  completed_at: string | null;
  tenant_id: string | null;
  last_activity_at: string;
  created_at: string;
  is_abandoned: boolean;
  hours_idle: number;
}
export interface OnboardingResponse {
  stats: OnboardingFunnelStats;
  sessions: OnboardingSessionRow[];
  filter: { status: string };
  generatedAt: string;
}
```

- [ ] **Step 2: Add key + hook**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `OnboardingResponse` to the import, add `onboarding: (status: string) => ['mk', 'onboarding', status] as const,` to `mk`, and:
```ts
// ---- Onboarding -------------------------------------------------------------
export const useOnboarding = (status: string) =>
  useQuery({
    queryKey: mk.onboarding(status),
    queryFn: () => plat.get<OnboardingResponse>(`/apps/${PRODUCT}/onboarding`, { status }),
  });
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/mark8ly/onboarding.tsx`:
```tsx
// Mark8ly onboarding — signup funnel KPIs + session list (read-only).
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useOnboarding } from '../../lib/mark8ly-hooks';
import type { OnboardingSessionRow } from '../../lib/mark8ly-contracts';
import { formatCount, formatDuration, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, StatGrid, StatTile, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const FILTERS = [
  { key: 'in_flight', label: 'In flight' },
  { key: 'completed', label: 'Completed' },
  { key: 'abandoned', label: 'Abandoned' },
  { key: 'all', label: 'All' },
];

function sessionTone(row: OnboardingSessionRow): Tone {
  if (row.completed_at) return 'success';
  if (row.is_abandoned) return 'danger';
  return 'info';
}

export default function Onboarding() {
  const [status, setStatus] = useState('in_flight');
  const q = useOnboarding(status);
  const s = q.data?.stats;
  const sessions = q.data?.sessions ?? [];

  return (
    <Screen>
      <ScreenHeader title="Onboarding" subtitle="Signup funnel" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3], paddingBottom: 8 }}>
              {q.isError ? <Banner text="Could not load onboarding." tone="danger" /> : null}
              {s ? (
                <StatGrid>
                  <StatTile label="In flight" value={formatCount(s.inFlight)} tone="info" />
                  <StatTile label="Verified" value={formatCount(s.emailVerified)} />
                  <StatTile label="Completed" value={formatCount(s.completed)} tone="success" />
                  <StatTile label="Abandoned" value={formatCount(s.abandoned)} tone={s.abandoned > 0 ? 'warning' : 'neutral'} />
                  <StatTile label="Median time" value={formatDuration(s.medianTimeToCompleteSeconds)} />
                  <StatTile label="Started 24h" value={formatCount(s.last24h.started)} />
                </StatGrid>
              ) : null}
              <FilterChips options={FILTERS} value={status} onChange={setStatus} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No sessions" body="Nothing matches this filter." />}
          renderItem={({ item }) => <SessionCard row={item} />}
        />
      )}
    </Screen>
  );
}

function SessionCard({ row }: { row: OnboardingSessionRow }) {
  const p = usePalette();
  const label = row.completed_at ? 'Completed' : row.is_abandoned ? 'Abandoned' : 'In flight';
  const body = (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{row.business_name || row.email}</Text>
        <Badge label={label} tone={sessionTone(row)} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
        {[row.email, row.email_verified_at ? 'verified' : 'unverified', `idle ${formatCount(row.hours_idle)}h`, formatRelative(row.created_at)].filter(Boolean).join(' · ')}
      </Text>
    </Card>
  );
  return row.tenant_id ? (
    <Pressable onPress={() => router.push(`/mark8ly/tenants/${row.tenant_id}` as never)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {body}
    </Pressable>
  ) : body;
}
```

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.
- [ ] **Step 5: Smoke test (controller)** — deep-link `tesserix-admin:///mark8ly/onboarding`. Expect funnel KPIs + status chips + session cards; sessions with a tenant deep-link to detail. Screenshot.
- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/onboarding.tsx
git commit -m "feat(mobile): mark8ly onboarding funnel screen"
```

---

## Task 3: Audit logs screen

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `AuditEventRow`, `AuditLogsResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `mk.audit`, `useMark8lyAuditLogs`)
- Create: `apps/mobile/app/mark8ly/audit-logs.tsx`

**Interfaces:**
- Produces: `AuditEventRow`, `AuditLogsResponse`; `useMark8lyAuditLogs(severity: string)` → `UseQueryResult<AuditLogsResponse>`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Audit logs -------------------------------------------------------------
export interface AuditEventRow {
  id: string;
  tenant_id: string;
  tenantName: string;
  store_id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  status: string;
  severity: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface AuditLogsResponse {
  summary: { criticalLast24h: number };
  filterOptions: { actions: string[]; resourceTypes: string[] };
  rows: AuditEventRow[];
  sinceHours: number;
  generatedAt: string;
}
```

- [ ] **Step 2: Add key + hook**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `AuditLogsResponse` to the import, add `audit: (severity: string) => ['mk', 'audit', severity] as const,` to `mk`, and:
```ts
// ---- Audit logs -------------------------------------------------------------
export const useMark8lyAuditLogs = (severity: string) =>
  useQuery({
    queryKey: mk.audit(severity),
    queryFn: () => plat.get<AuditLogsResponse>(`/apps/${PRODUCT}/audit-logs`, { severity: severity !== 'all' ? severity : undefined }),
  });
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/mark8ly/audit-logs.tsx`:
```tsx
// Mark8ly audit logs — event feed with severity filter (read-only).
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMark8lyAuditLogs } from '../../lib/mark8ly-hooks';
import type { AuditEventRow } from '../../lib/mark8ly-contracts';
import { formatCount, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, StatGrid, StatTile, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

// severity is an open string; 'critical' is the one guaranteed value. Chips are a
// pragmatic fixed set — unmatched values simply filter to empty.
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'error', label: 'Error' },
  { key: 'warning', label: 'Warning' },
  { key: 'info', label: 'Info' },
];

function sevTone(s: string): Tone {
  const v = s.toLowerCase();
  if (v === 'critical' || v === 'error') return 'danger';
  if (v === 'warning') return 'warning';
  if (v === 'info') return 'info';
  return 'neutral';
}

export default function AuditLogs() {
  const [severity, setSeverity] = useState('all');
  const q = useMark8lyAuditLogs(severity);
  const rows = q.data?.rows ?? [];

  return (
    <Screen>
      <ScreenHeader title="Audit logs" subtitle="Mark8ly admin trail" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ gap: 8, paddingHorizontal: space[4], paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          ListHeaderComponent={
            <View style={{ gap: space[3], paddingBottom: 8 }}>
              {q.isError ? <Banner text="Could not load audit logs." tone="danger" /> : null}
              {q.data ? (
                <StatGrid>
                  <StatTile label="Critical 24h" value={formatCount(q.data.summary.criticalLast24h)} tone={q.data.summary.criticalLast24h > 0 ? 'danger' : 'neutral'} />
                  <StatTile label="Events" value={formatCount(rows.length)} />
                </StatGrid>
              ) : null}
              <FilterChips options={FILTERS} value={severity} onChange={setSeverity} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="No events" body="No audit events for this filter." />}
          renderItem={({ item }) => <EventCard e={item} />}
        />
      )}
    </Screen>
  );
}

function EventCard({ e }: { e: AuditEventRow }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const hasMeta = e.metadata && Object.keys(e.metadata).length > 0;
  return (
    <Pressable onPress={hasMeta ? () => setOpen((v) => !v) : undefined} style={({ pressed }) => ({ opacity: pressed && hasMeta ? 0.6 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{e.action}</Text>
          <Badge label={titleCase(e.severity)} tone={sevTone(e.severity)} />
        </View>
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
          {[e.resource_type + (e.resource_id ? ` ${e.resource_id}` : ''), e.actor_email, e.tenantName, formatRelative(e.created_at)].filter(Boolean).join(' · ')}
        </Text>
        {open && hasMeta ? (
          <Text style={[text.mono, { color: p.mutedForeground, marginTop: 8, fontSize: 11 }]}>{JSON.stringify(e.metadata, null, 2)}</Text>
        ) : null}
      </Card>
    </Pressable>
  );
}
```

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.
- [ ] **Step 5: Smoke test (controller)** — deep-link `tesserix-admin:///mark8ly/audit-logs`. Expect critical tile + severity chips + event cards; tap an event with metadata to expand the JSON. Screenshot.
- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/audit-logs.tsx
git commit -m "feat(mobile): mark8ly audit logs screen"
```

---

## Task 4: Email templates screen (read-only + Send-test)

**Files:**
- Modify: `apps/mobile/lib/mark8ly-contracts.ts` (add `EmailTemplateRow`, `EmailTemplatesResponse`, `EmailTestSendResponse`)
- Modify: `apps/mobile/lib/mark8ly-hooks.ts` (add `mk.emailTemplates`, `useEmailTemplates`, `useTestSendEmailTemplate`)
- Create: `apps/mobile/app/mark8ly/templates.tsx`

**Interfaces:**
- Consumes: `useAuth` (`../../lib/auth`), `apiError` (`../../lib/api`).
- Produces: the 3 types; `useEmailTemplates(database: string)`, `useTestSendEmailTemplate(key: string, database: string)` (mutation taking `to: string`).

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/mark8ly-contracts.ts`:
```ts
// ---- Email templates --------------------------------------------------------
export type Mark8lyDatabase = 'platform_api' | 'marketplace_api';
export interface EmailTemplateRow {
  database: Mark8lyDatabase;
  key: string;
  subject: string;
  status: 'published' | 'draft';
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}
export interface EmailTemplatesResponse {
  database: Mark8lyDatabase;
  templates: EmailTemplateRow[];
}
export interface EmailTestSendResponse {
  sent: true;
  to: string;
}
```
Note: the wire also carries `htmlBody`/`textBody`/`variables` on each template — we omit them from `EmailTemplateRow` (extra fields are ignored) since this screen is list-only.

- [ ] **Step 2: Add keys + hooks**

In `apps/mobile/lib/mark8ly-hooks.ts`: add `EmailTemplatesResponse`, `EmailTestSendResponse` to the import, add `emailTemplates: (database: string) => ['mk', 'email-templates', database] as const,` to `mk`, and:
```ts
// ---- Email templates (flat /email-templates, not product-scoped) ------------
export const useEmailTemplates = (database: string) =>
  useQuery({
    queryKey: mk.emailTemplates(database),
    queryFn: () => plat.get<EmailTemplatesResponse>('/email-templates', { database }),
  });

export function useTestSendEmailTemplate(key: string, database: string) {
  // plat.post has no params arg → database goes in the query string.
  return useMutation({
    mutationFn: (to: string) =>
      plat.post<EmailTestSendResponse>(`/email-templates/${key}/test-send?database=${database}`, { to }),
  });
}
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/mark8ly/templates.tsx`:
```tsx
// Mark8ly email templates — read-only list (DB toggle) + per-template Send-test.
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useEmailTemplates, useTestSendEmailTemplate } from '../../lib/mark8ly-hooks';
import type { EmailTemplateRow } from '../../lib/mark8ly-contracts';
import { useAuth } from '../../lib/auth';
import { apiError } from '../../lib/api';
import { formatRelative } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, FilterChips,
  EmptyState, LoadingRows, Banner, type Tone,
} from '../../components/kit';
import { usePalette, radius, space, text } from '../../lib/theme';

const DB_OPTS = [
  { key: 'platform_api', label: 'Platform' },
  { key: 'marketplace_api', label: 'Marketplace' },
];

export default function Templates() {
  const [database, setDatabase] = useState('platform_api');
  const q = useEmailTemplates(database);
  const templates = q.data?.templates ?? [];

  return (
    <Screen>
      <ScreenHeader title="Email templates" subtitle="Mark8ly notifications" right={<BackButton onPress={() => router.back()} />} />
      <View style={{ paddingHorizontal: space[4], paddingBottom: 8 }}>
        <FilterChips options={DB_OPTS} value={database} onChange={setDatabase} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 8 }}>
          {q.isError ? <Banner text="Could not load templates." tone="danger" /> : null}
          {templates.length === 0 ? (
            <Card><EmptyState title="No templates" body="No templates in this database." /></Card>
          ) : (
            templates.map((t) => <TemplateCard key={`${database}:${t.key}`} t={t} database={database} />)
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

function TemplateCard({ t, database }: { t: EmailTemplateRow; database: string }) {
  const p = usePalette();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(user?.email ?? '');
  const send = useTestSendEmailTemplate(t.key, database);
  const statusTone: Tone = t.status === 'published' ? 'success' : 'neutral';

  function submit() {
    if (!to.trim()) { Alert.alert('Missing email', 'Enter a recipient email.'); return; }
    send.mutate(to.trim(), {
      onSuccess: (r) => { setOpen(false); Alert.alert('Test sent', `Sent to ${r.to}.`); },
      onError: (e) => Alert.alert('Send failed', apiError(e)),
    });
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{t.key}</Text>
        <Badge label={t.status} tone={statusTone} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>{t.subject}</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>v{t.version} · {formatRelative(t.updatedAt)}</Text>
      {open ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <TextInput
            value={to}
            onChangeText={setTo}
            placeholder="recipient@example.com"
            placeholderTextColor={p.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Button label="Send test" onPress={submit} loading={send.isPending} /></View>
            <View style={{ flex: 1 }}><Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} disabled={send.isPending} /></View>
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 12 }}><Button label="Send test" variant="secondary" onPress={() => setOpen(true)} /></View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    fontFamily: 'InterTight',
    fontSize: 15,
  },
});
```

- [ ] **Step 4: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.
- [ ] **Step 5: Smoke test (controller)** — deep-link `tesserix-admin:///mark8ly/templates`. Expect a DB toggle + template cards; switching DB reloads; tap "Send test" → email field (seeded) → Send → "Test sent" (or a clear error). Screenshot.
- [ ] **Step 6: Commit**
```bash
git add apps/mobile/lib/mark8ly-contracts.ts apps/mobile/lib/mark8ly-hooks.ts apps/mobile/app/mark8ly/templates.tsx
git commit -m "feat(mobile): mark8ly email templates list with send-test"
```

---

## Task 5: Flip the 4 hub items live

**Files:**
- Modify: `apps/mobile/app/mark8ly/index.tsx`

- [ ] **Step 1: Flip live flags**

In `apps/mobile/app/mark8ly/index.tsx`, the SECTIONS array has four items with `live: false`: `Onboarding` (route `/mark8ly/onboarding`), `Subscriptions` (`/mark8ly/subscriptions`), `Audit logs` (`/mark8ly/audit-logs`), and `Email templates` (`/mark8ly/templates`). Change each of those four `live: false` → `live: true`. Do not change the already-live items (Overview, Leads, Tenants) or the routes.

- [ ] **Step 2: Typecheck** — `cd apps/mobile && npx tsc --noEmit`; expected no errors.
- [ ] **Step 3: Smoke test (controller)** — reload app → Apps → Mark8ly hub: all items now tappable (no "Soon"); each opens its screen. Screenshot.
- [ ] **Step 4: Commit**
```bash
git add apps/mobile/app/mark8ly/index.tsx
git commit -m "feat(mobile): mark8ly hub — all sections live"
```

---

## Task 6: Final verification + push

- [ ] **Step 1: Typecheck + doctor** — `cd apps/mobile && npx tsc --noEmit && npx expo-doctor` (tsc clean; expo-doctor no NEW issues).
- [ ] **Step 2: Full smoke pass** — sign in, Apps → Mark8ly → open Subscriptions, Onboarding, Audit logs (expand a metadata), Templates (DB toggle + Send-test). Confirm real data + the Send-test action. Screenshot each.
- [ ] **Step 3: Push** — `git push origin main` (redeploys the web `company` image — mobile-only, harmless).

---

## Self-review notes (spec coverage)

- Subscriptions → Task 1. Onboarding → Task 2. Audit logs → Task 3. Email templates (list + Send-test) → Task 4. Hub flip → Task 5. Verification → Task 6.
- Data layer extended in `mark8ly-contracts.ts` + `mark8ly-hooks.ts` (Tasks 1–4). Email-templates endpoints are FLAT (`/email-templates`), and the send-test `database` param is in the POST query string (plat.post has no params arg).
- Deferred per spec (NOT in plan): template HTML/text editing + preview; audit full facet filters (severity only); subscription/onboarding sorting. Severity chips are a fixed pragmatic set (only `critical` is guaranteed by the backend).
- Deep-links to `/mark8ly/tenants/{id}` (existing route) use `as never` per codebase convention.
