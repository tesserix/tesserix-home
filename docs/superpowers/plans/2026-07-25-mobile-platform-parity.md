# Mobile Platform Section — Read + Key Actions Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 4 missing Platform screens to the Expo mobile admin (Support Analytics, Notifications Log, Lead Templates, Observability Trace detail) at read + key-actions parity with the web admin.

**Architecture:** Each screen is a read-only (or read + one action) expo-router screen under `apps/mobile/app/platform/`, backed by a TanStack Query hook in `lib/platform-hooks.ts` calling the existing web `/api/admin/*` routes via the `plat` client, with response types mirrored into `lib/platform-contracts.ts`. No new backend. Screens mirror the structure of the existing `outbox.tsx` / `health.tsx` (Screen + ScreenHeader + StatGrid/StatTile + Card + kit components + `usePalette`/`space`/`text`).

**Tech Stack:** Expo SDK 56 / React Native 0.85.3, expo-router (file-based routing), TanStack Query v5, axios (via `plat` client), `@tesserix/homechef-shared` formatters, kit components in `apps/mobile/components/kit.tsx`.

## Global Constraints

- Node/Metro runs on **port 8082** (`RCT_METRO_PORT=8082 npx expo run:ios --port 8082`); 8081 is taken by a Docker container. A dev build (expo-dev-client) is required to run on device.
- `EXPO_PUBLIC_API_BASE=https://tesserix.app` (in `apps/mobile/.env`, gitignored). **Never** `home.tesserix.app` (unrouted → Istio 403).
- All new API calls use the existing `plat` client (`apps/mobile/lib/api.ts`) which prefixes `/api/admin` and attaches the bearer + `Origin` header. **No `plat` client changes.**
- **No RN unit-test runner exists** in this project (package.json scripts: start/ios/android/typecheck only). The per-task gate is: `cd apps/mobile && npx tsc --noEmit` passes cleanly **and** a smoke test on the booted iPhone 17 Pro simulator (Metro on 8082) — the screen renders real prod data and any action works. Do not fabricate a test framework.
- Match existing conventions exactly: import kit from `../../components/kit`, theme from `../../lib/theme` (`usePalette`, `space`, `text`, `radius`), hooks from `../../lib/platform-hooks`, types from `../../lib/platform-contracts`, formatters from `@tesserix/homechef-shared` (`formatCount`, `formatDuration`, `formatPct`, `formatRelative`, `formatDateTime`, `titleCase`).
- Files stay focused (~100–200 lines, one screen per file), matching siblings.
- Commit messages: conventional, single-line, no signatures.

## Smoke-test harness (used by every task)

Metro + sim should already be running from the auth session. If not:
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/apps/mobile
RCT_METRO_PORT=8082 npx expo run:ios --device "iPhone 17 Pro" --port 8082   # first time (build), else:
RCT_METRO_PORT=8082 npx expo start --dev-client --port 8082                  # Metro only, then reload app
```
To reach a new screen during smoke test, either navigate via the Platform tab (after Task 6) or deep-link it:
```bash
xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///platform/analytics-support"
```
Screenshot to verify: `xcrun simctl io AD109A46-2F99-43C3-8AAA-FEE68DC8499E screenshot /tmp/shot.png`.

---

## Task 1: Data-layer cleanup — correct the `api.ts` fallback host

**Files:**
- Modify: `apps/mobile/lib/api.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new (behavioral correctness only).

- [ ] **Step 1: Fix the fallback default host**

In `apps/mobile/lib/api.ts`, change:
```ts
const BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://home.tesserix.app';
```
to:
```ts
const BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://tesserix.app';
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/lib/api.ts
git commit -m "fix(mobile): correct api.ts fallback host to tesserix.app"
```

---

## Task 2: Observability Trace detail screen

Adds a trace drill-down reached from the existing observability screen's recent-trace rows.

**Files:**
- Modify: `apps/mobile/lib/platform-contracts.ts` (add `TraceSpan`, `TraceDetail`)
- Modify: `apps/mobile/lib/platform-hooks.ts` (add `pk.trace`, `useTrace`)
- Create: `apps/mobile/app/platform/trace/[id].tsx`
- Modify: `apps/mobile/app/platform/observability.tsx` (make recent-trace rows tappable)

**Interfaces:**
- Consumes: `plat` client; `ObsTrace` (already in contracts, has `traceId`).
- Produces: `useTrace(id: string)` → `UseQueryResult<TraceDetail>`; `TraceDetail = { traceId: string; spans: TraceSpan[] }`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- Observability trace detail --------------------------------------------
// Span shape is SQL-derived (no shared TS type on the web side); nanosecond
// numerics may arrive as strings from ClickHouse.
export interface TraceSpan {
  spanId: string;
  parentId: string;
  service: string;
  op: string;
  kind: string;
  startNs: number | string;
  durationNs: number | string;
  status: 'Error' | 'OK';
}
export interface TraceDetail {
  traceId: string;
  spans: TraceSpan[];
}
```

- [ ] **Step 2: Add the query key + hook**

In `apps/mobile/lib/platform-hooks.ts`: add `TraceDetail` to the type import from `./platform-contracts`, add a key to the `pk` object:
```ts
  trace: (id: string) => ['plat', 'trace', id] as const,
```
and add the hook (place near `useObservability`):
```ts
export const useTrace = (id: string) =>
  useQuery({
    queryKey: pk.trace(id),
    queryFn: () => plat.get<TraceDetail>('/observability/trace', { id }),
    enabled: !!id,
  });
```

- [ ] **Step 3: Create the trace-detail screen**

Create `apps/mobile/app/platform/trace/[id].tsx`:
```tsx
// Trace detail — spans for one distributed trace, indented by parent depth.
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTrace } from '../../../lib/platform-hooks';
import type { TraceSpan } from '../../../lib/platform-contracts';
import { formatMs } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, EmptyState, LoadingRows, StatusDot, type Tone,
} from '../../../components/kit';
import { usePalette, space, text } from '../../../lib/theme';

// Duration nanoseconds -> milliseconds (CH may serialize the number as a string).
function ms(ns: number | string): number {
  return Number(ns) / 1_000_000;
}

// depth of each span = length of its parent chain within this trace.
function computeDepths(spans: TraceSpan[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    const s = byId.get(id);
    if (!s || !s.parentId || !byId.has(s.parentId) || seen.has(id)) {
      depth.set(id, 0);
      return 0;
    }
    seen.add(id);
    const d = resolve(s.parentId, seen) + 1;
    depth.set(id, d);
    return d;
  };
  spans.forEach((s) => resolve(s.spanId, new Set()));
  return depth;
}

export default function TraceDetail() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useTrace(id ?? '');
  const spans = q.data?.spans ?? [];
  const depths = computeDepths(spans);

  return (
    <Screen>
      <ScreenHeader
        title="Trace"
        subtitle={id ? `${id.slice(0, 16)}…` : undefined}
        right={<BackButton onPress={() => router.back()} />}
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : spans.length === 0 ? (
        <Card>
          <EmptyState title="No spans" body={q.isError ? 'Could not load this trace.' : 'This trace has no spans.'} />
        </Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 8 }}>
          {spans.map((s) => {
            const d = depths.get(s.spanId) ?? 0;
            const tone: Tone = s.status === 'Error' ? 'danger' : 'success';
            return (
              <View key={s.spanId} style={{ marginLeft: Math.min(d, 8) * 14 }}>
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <StatusDot tone={tone} />
                    <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>
                      {s.op}
                    </Text>
                    <Text style={[text.mono, { color: p.mutedForeground }]}>{formatMs(ms(s.durationNs))}</Text>
                  </View>
                  <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>
                    {s.service}{s.kind ? ` · ${s.kind}` : ''}
                  </Text>
                </Card>
              </View>
            );
          })}
        </ScrollView>
      )}
    </Screen>
  );
}
```

- [ ] **Step 4: Make recent-trace rows tappable in observability.tsx**

In `apps/mobile/app/platform/observability.tsx`, the recent-traces `ListRow` currently has no `onPress`. Ensure `router` is imported (`import { router } from 'expo-router';` — it already is), and add `onPress` to that `ListRow`:
```tsx
<ListRow
  key={`${t.traceId}:${i}`}
  title={t.op}
  subtitle={`${t.service} · ${formatRelative(t.ts)}`}
  meta={formatMs(t.durationMs)}
  trailing={<Badge label={t.status} tone={t.status === 'Error' ? 'danger' : 'success'} />}
  onPress={() => router.push(`/platform/trace/${t.traceId}`)}
/>
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Smoke test on sim**

Reload the app. Open Observability (Platform tab → Observability), tap a recent trace row.
Expected: the trace screen renders a list of spans indented by depth, each with op/service/duration and a status dot. Verify no red-box. Screenshot to confirm.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/platform-contracts.ts apps/mobile/lib/platform-hooks.ts apps/mobile/app/platform/trace/ apps/mobile/app/platform/observability.tsx
git commit -m "feat(mobile): observability trace detail with span drill-down"
```

---

## Task 3: Support Analytics screen

**Files:**
- Modify: `apps/mobile/lib/platform-contracts.ts` (add `PlatformSupportStats`)
- Modify: `apps/mobile/lib/platform-hooks.ts` (add `pk.supportAnalytics`, `useSupportAnalytics`)
- Create: `apps/mobile/app/platform/analytics-support.tsx`

**Interfaces:**
- Consumes: `plat` client.
- Produces: `useSupportAnalytics()` → `UseQueryResult<PlatformSupportStats>`.

- [ ] **Step 1: Add contract type**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- Support analytics (Otto cross-tenant rollup) --------------------------
export interface PlatformSupportStats {
  total: number;
  open: number;
  by_status: Record<string, number>;
  by_reason: Record<string, number>;
  by_tenant: Record<string, number>;
  escalated: number;
  ai_resolved: number;
  avg_resolution_seconds: number;
  csat: number;
  resolved_rate: number;
  feedback_count: number;
  tenant_names?: Record<string, string>;
}
```

- [ ] **Step 2: Add key + hook**

In `apps/mobile/lib/platform-hooks.ts`: add `PlatformSupportStats` to the contracts import, add key:
```ts
  supportAnalytics: ['plat', 'support-analytics'] as const,
```
and hook:
```ts
export const useSupportAnalytics = () =>
  useQuery({
    queryKey: pk.supportAnalytics,
    queryFn: () => plat.get<PlatformSupportStats>('/analytics/support'),
    refetchInterval: 30_000,
  });
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/platform/analytics-support.tsx`:
```tsx
// Support analytics — Otto cross-tenant support rollup (KPIs + breakdowns).
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSupportAnalytics } from '../../lib/platform-hooks';
import { formatCount, formatDuration, formatPct } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, StatGrid, StatTile, SectionLabel, EmptyState, LoadingRows,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

type Row = { label: string; value: number };

function toRows(m: Record<string, number> | undefined, rename?: (k: string) => string): Row[] {
  if (!m) return [];
  return Object.entries(m)
    .map(([k, v]) => ({ label: rename ? rename(k) : k, value: v }))
    .sort((a, b) => b.value - a.value);
}

function RankedList({ title, rows }: { title: string; rows: Row[] }) {
  const p = usePalette();
  const max = rows.reduce((a, r) => Math.max(a, r.value), 0) || 1;
  return (
    <View style={{ paddingHorizontal: space[4] }}>
      <SectionLabel>{title}</SectionLabel>
      {rows.length === 0 ? (
        <Card><EmptyState title="No data" /></Card>
      ) : (
        <View style={{ gap: 8 }}>
          {rows.map((r) => (
            <Card key={r.label}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[text.body, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{r.label}</Text>
                <Text style={[text.mono, { color: p.mutedForeground }]}>{formatCount(r.value)}</Text>
              </View>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: p.muted, marginTop: 8 }}>
                <View style={{ height: 4, borderRadius: 2, width: `${(r.value / max) * 100}%`, backgroundColor: p.foreground }} />
              </View>
            </Card>
          ))}
        </View>
      )}
    </View>
  );
}

export default function SupportAnalytics() {
  const p = usePalette();
  const q = useSupportAnalytics();
  const d = q.data;

  return (
    <Screen>
      <ScreenHeader title="Support analytics" subtitle="Otto rollup" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : !d ? (
        <Card><EmptyState title="Unavailable" body="Support analytics could not be loaded." /></Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}>
          <StatGrid>
            <StatTile label="Total" value={formatCount(d.total)} />
            <StatTile label="Open" value={formatCount(d.open)} tone={d.open > 0 ? 'info' : 'neutral'} />
            <StatTile label="AI-resolved" value={formatCount(d.ai_resolved)} tone={d.ai_resolved > 0 ? 'success' : 'neutral'} />
            <StatTile label="Escalated" value={formatCount(d.escalated)} tone={d.escalated > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Avg resolution" value={formatDuration(d.avg_resolution_seconds)} />
            <StatTile label="CSAT" value={d.csat ? `${d.csat.toFixed(1)} / 5` : '—'} />
            <StatTile label="Resolved rate" value={d.feedback_count ? formatPct(d.resolved_rate) : '—'} />
            <StatTile label="Feedback" value={formatCount(d.feedback_count)} />
          </StatGrid>
          <RankedList title="By status" rows={toRows(d.by_status)} />
          <RankedList title="By reason" rows={toRows(d.by_reason)} />
          <RankedList title="By tenant" rows={toRows(d.by_tenant, (id) => d.tenant_names?.[id] ?? id)} />
        </ScrollView>
      )}
    </Screen>
  );
}
```
Note: `formatPct` expects a 0..1 ratio; `resolved_rate` is a 0..1 ratio on the wire. If `formatPct` instead expects 0..100, use `formatPct(d.resolved_rate * 100)` — verify against a sibling usage before finalizing.

- [ ] **Step 4: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Smoke test on sim**

Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///platform/analytics-support"`
Expected: 8 KPI tiles populate with real numbers, and the three ranked lists render with bars. No red-box. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/platform-contracts.ts apps/mobile/lib/platform-hooks.ts apps/mobile/app/platform/analytics-support.tsx
git commit -m "feat(mobile): support analytics screen (Otto rollup)"
```

---

## Task 4: Notifications Log screen (email events)

**Files:**
- Modify: `apps/mobile/lib/platform-contracts.ts` (add email-events types)
- Modify: `apps/mobile/lib/platform-hooks.ts` (add `useEmailMetrics`, `useEmailRecent`)
- Create: `apps/mobile/app/platform/notifications-log.tsx`

**Interfaces:**
- Consumes: `plat` client, `FilterChips` kit component.
- Produces: `useEmailMetrics(days: number, product?: string)` → `UseQueryResult<EmailMetricsResponse>`; `useEmailRecent(product?: string)` → `UseQueryResult<EmailRecentResponse>`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- Email events (notifications log) --------------------------------------
export interface EmailMetricsRow {
  product: string;
  tenantId: string | null;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  bounces: number;
  drops: number;
  unsubscribes: number;
}
export interface EmailMetricsResponse {
  days: number;
  rows: EmailMetricsRow[];
}
export interface EmailEventLogRow {
  id: number;
  sgEventId: string;
  eventType: string;
  product: string | null;
  tenantId: string | null;
  templateKey: string | null;
  recipient: string | null;
  reason: string | null;
  eventAt: string;
}
export interface EmailRecentResponse {
  events: EmailEventLogRow[];
}
```

- [ ] **Step 2: Add keys + hooks**

In `apps/mobile/lib/platform-hooks.ts`: add `EmailMetricsResponse`, `EmailRecentResponse` to the import, add keys:
```ts
  emailMetrics: (p: object) => ['plat', 'email-metrics', p] as const,
  emailRecent: (p: object) => ['plat', 'email-recent', p] as const,
```
and hooks:
```ts
export const useEmailMetrics = (days: number, product?: string) =>
  useQuery({
    queryKey: pk.emailMetrics({ days, product }),
    queryFn: () => plat.get<EmailMetricsResponse>('/email-events', { view: 'metrics', days, product: product || undefined }),
  });

export const useEmailRecent = (product?: string) =>
  useQuery({
    queryKey: pk.emailRecent({ product }),
    queryFn: () => plat.get<EmailRecentResponse>('/email-events', { view: 'recent', product: product || undefined, limit: 100 }),
  });
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/platform/notifications-log.tsx`:
```tsx
// Notifications log — SendGrid email delivery metrics + recent events.
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useEmailMetrics, useEmailRecent } from '../../lib/platform-hooks';
import type { EmailMetricsRow, EmailEventLogRow } from '../../lib/platform-contracts';
import { formatCount, formatPct, formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, StatGrid, StatTile, SectionLabel, Badge,
  EmptyState, LoadingRows, FilterChips, type Tone,
} from '../../components/kit';
import { usePalette, space, text } from '../../lib/theme';

const DAY_OPTS = [
  { key: '7', label: '7d' },
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
];

function sum(rows: EmailMetricsRow[], f: (r: EmailMetricsRow) => number): number {
  return rows.reduce((a, r) => a + f(r), 0);
}

function eventTone(type: string): Tone {
  const t = type.toLowerCase();
  if (t.includes('bounce') || t.includes('dropped') || t.includes('spam')) return 'danger';
  if (t.includes('deliver')) return 'success';
  if (t.includes('open') || t.includes('click')) return 'info';
  if (t.includes('unsub')) return 'warning';
  return 'neutral';
}

export default function NotificationsLog() {
  const p = usePalette();
  const [days, setDays] = useState('30');
  const [product, setProduct] = useState('all');

  const metrics = useEmailMetrics(Number(days), product === 'all' ? undefined : product);
  const recent = useEmailRecent(product === 'all' ? undefined : product);

  const rows = metrics.data?.rows ?? [];
  const productOpts = useMemo(() => {
    const set = Array.from(new Set(rows.map((r) => r.product).filter(Boolean)));
    return [{ key: 'all', label: 'All' }, ...set.map((pr) => ({ key: pr, label: pr }))];
  }, [rows]);

  const sent = sum(rows, (r) => r.sent);
  const delivered = sum(rows, (r) => r.delivered);
  const opens = sum(rows, (r) => r.opens);
  const clicks = sum(rows, (r) => r.clicks);
  const bounces = sum(rows, (r) => r.bounces);
  const unsub = sum(rows, (r) => r.unsubscribes);
  const events = recent.data?.events ?? [];

  return (
    <Screen>
      <ScreenHeader title="Notifications log" subtitle="Email delivery" right={<BackButton onPress={() => router.back()} />} />
      {metrics.isLoading ? (
        <LoadingRows />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space[10], gap: space[4] }}
        >
          <View style={{ paddingHorizontal: space[4], gap: 8 }}>
            <FilterChips options={DAY_OPTS} value={days} onChange={setDays} />
            {productOpts.length > 1 ? <FilterChips options={productOpts} value={product} onChange={setProduct} /> : null}
          </View>

          <StatGrid>
            <StatTile label="Sent" value={formatCount(sent)} />
            <StatTile label="Delivered" value={sent ? formatPct((delivered / sent) * 100) : '—'} />
            <StatTile label="Opens" value={delivered ? formatPct((opens / delivered) * 100) : '—'} />
            <StatTile label="Clicks" value={formatCount(clicks)} />
            <StatTile label="Bounces" value={formatCount(bounces)} tone={bounces > 0 ? 'warning' : 'neutral'} />
            <StatTile label="Unsub" value={formatCount(unsub)} />
          </StatGrid>

          <View style={{ paddingHorizontal: space[4] }}>
            <SectionLabel>Recent events</SectionLabel>
            {events.length === 0 ? (
              <Card><EmptyState title="No events" body="No recent email events for this filter." /></Card>
            ) : (
              <View style={{ gap: 8 }}>
                {events.map((e) => (
                  <EventCard key={e.id} e={e} />
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

function EventCard({ e }: { e: EmailEventLogRow }) {
  const p = usePalette();
  const meta = [e.product, e.templateKey].filter(Boolean).join(' · ');
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Badge label={titleCase(e.eventType)} tone={eventTone(e.eventType)} />
        <View style={{ flex: 1 }} />
        <Text style={[text.caption, { color: p.mutedForeground }]}>{formatRelative(e.eventAt)}</Text>
      </View>
      {e.recipient ? (
        <Text style={[text.body, { color: p.foreground, marginTop: 8 }]} numberOfLines={1}>{e.recipient}</Text>
      ) : null}
      {meta ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>{meta}</Text>
      ) : null}
      {e.reason ? (
        <Text style={[text.caption, { color: p.destructiveFg, marginTop: 4 }]} numberOfLines={2}>{e.reason}</Text>
      ) : null}
    </Card>
  );
}
```
Note: `formatPct` percentage-vs-ratio convention — verify against a sibling (the code above passes a 0..100 number). If `formatPct` expects a 0..1 ratio, drop the `* 100`.

- [ ] **Step 4: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Smoke test on sim**

Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///platform/notifications-log"`
Expected: 6 KPI tiles populate, day-window chips switch the data, recent-event cards list with type badges. No red-box. Screenshot.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/platform-contracts.ts apps/mobile/lib/platform-hooks.ts apps/mobile/app/platform/notifications-log.tsx
git commit -m "feat(mobile): notifications log screen (email metrics + events)"
```

---

## Task 5: Lead Templates screen (read + Send test)

**Files:**
- Modify: `apps/mobile/lib/platform-contracts.ts` (add lead-template types)
- Modify: `apps/mobile/lib/platform-hooks.ts` (add `useLeadTemplates`, `useTestSendTemplate`)
- Create: `apps/mobile/app/platform/lead-templates.tsx`

**Interfaces:**
- Consumes: `plat` client, `useAuth` (from `../../lib/auth`, provides `user.email` to seed the recipient), `Button`/`TextInput`.
- Produces: `useLeadTemplates()` → `UseQueryResult<LeadTemplatesResponse>`; `useTestSendTemplate(key: string)` → mutation taking a `to: string`.

- [ ] **Step 1: Add contract types**

Append to `apps/mobile/lib/platform-contracts.ts`:
```ts
// ---- Lead email templates --------------------------------------------------
export type LeadTemplateStatus = 'published' | 'draft';
export interface LeadTemplate {
  key: string;
  label: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  variables: { name: string; type: string; required: boolean }[];
  status: LeadTemplateStatus;
  product: string;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}
export interface LeadTemplatesResponse {
  templates: LeadTemplate[];
}
export interface TestSendResponse {
  sent: true;
  to: string;
  messageId?: string;
}
```

- [ ] **Step 2: Add keys + hooks**

In `apps/mobile/lib/platform-hooks.ts`: add `LeadTemplatesResponse`, `TestSendResponse` to the import, add key:
```ts
  leadTemplates: ['plat', 'lead-templates'] as const,
```
and hooks (the mutation needs no invalidation — it sends an email, no list change):
```ts
export const useLeadTemplates = () =>
  useQuery({ queryKey: pk.leadTemplates, queryFn: () => plat.get<LeadTemplatesResponse>('/lead-templates') });

export function useTestSendTemplate(key: string) {
  return useMutation({
    mutationFn: (to: string) => plat.post<TestSendResponse>(`/lead-templates/${key}/test-send`, { to }),
  });
}
```

- [ ] **Step 3: Create the screen**

Create `apps/mobile/app/platform/lead-templates.tsx`:
```tsx
// Lead email templates — read-only list + per-template "Send test".
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useLeadTemplates, useTestSendTemplate } from '../../lib/platform-hooks';
import type { LeadTemplate } from '../../lib/platform-contracts';
import { useAuth } from '../../lib/auth';
import { apiError } from '../../lib/api';
import { formatRelative } from '@tesserix/homechef-shared';
import {
  Screen, ScreenHeader, BackButton, Card, Badge, Button, SectionLabel, EmptyState, LoadingRows, type Tone,
} from '../../components/kit';
import { usePalette, radius, space, text } from '../../lib/theme';

export default function LeadTemplates() {
  const q = useLeadTemplates();
  const templates = q.data?.templates ?? [];

  return (
    <Screen>
      <ScreenHeader title="Lead templates" subtitle="Marketing email templates" right={<BackButton onPress={() => router.back()} />} />
      {q.isLoading ? (
        <LoadingRows />
      ) : templates.length === 0 ? (
        <Card><EmptyState title="No templates" body={q.isError ? 'Could not load templates.' : 'No lead templates defined.'} /></Card>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[10], gap: 8 }}>
          {templates.map((t) => <TemplateCard key={t.key} t={t} />)}
        </ScrollView>
      )}
    </Screen>
  );
}

function TemplateCard({ t }: { t: LeadTemplate }) {
  const p = usePalette();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(user?.email ?? '');
  const send = useTestSendTemplate(t.key);
  const statusTone: Tone = t.status === 'published' ? 'success' : 'neutral';

  function submit() {
    if (!to.trim()) {
      Alert.alert('Missing email', 'Enter a recipient email address.');
      return;
    }
    send.mutate(to.trim(), {
      onSuccess: (r) => { setOpen(false); Alert.alert('Test sent', `Sent to ${r.to}.`); },
      onError: (e) => Alert.alert('Send failed', apiError(e)),
    });
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[text.title, { color: p.foreground, flex: 1 }]} numberOfLines={1}>{t.label}</Text>
        <Badge label={t.status} tone={statusTone} />
      </View>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 4 }]} numberOfLines={1}>{t.subject}</Text>
      <Text style={[text.caption, { color: p.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
        {t.product} · v{t.version} · {formatRelative(t.updatedAt)}
      </Text>
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
            <View style={{ flex: 1 }}>
              <Button label="Send test" onPress={submit} loading={send.isPending} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} disabled={send.isPending} />
            </View>
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <Button label="Send test" variant="secondary" onPress={() => setOpen(true)} />
        </View>
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

- [ ] **Step 4: Verify the `useAuth` shape**

Confirm `apps/mobile/lib/auth.tsx` exports `useAuth()` returning `{ user: { email: string } | null }` (it does — used by login). If the property differs, adjust `user?.email`.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Smoke test on sim**

Deep-link: `xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E "tesserix-admin:///platform/lead-templates"`
Expected: template cards list with label/subject/status. Tap "Send test" → email field (seeded with your address) → Send → "Test sent" alert (or a clear error alert). No red-box. Screenshot.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/platform-contracts.ts apps/mobile/lib/platform-hooks.ts apps/mobile/app/platform/lead-templates.tsx
git commit -m "feat(mobile): lead templates screen with send-test action"
```

---

## Task 6: Wire the 3 new screens into the Platform tab

**Files:**
- Modify: `apps/mobile/app/(tabs)/platform.tsx`

**Interfaces:**
- Consumes: the routes `/platform/analytics-support`, `/platform/notifications-log`, `/platform/lead-templates` (created in Tasks 3–5).
- Produces: navigation entries.

- [ ] **Step 1: Add nav items**

In `apps/mobile/app/(tabs)/platform.tsx`:
- Add icons to the lucide import line: `BarChart3, Mail, FileText` (append to the existing destructured import).
- Add `{ title: 'Support analytics', sub: 'Otto support rollup', icon: BarChart3, route: '/platform/analytics-support', live: true }` to the **Support** group's `items` array.
- Add a new group after **Support** (or before **Governance**):
```ts
  { group: 'Notifications', items: [
    { title: 'Notifications log', sub: 'Email delivery + events', icon: Mail, route: '/platform/notifications-log', live: true },
    { title: 'Lead templates', sub: 'Marketing emails + test send', icon: FileText, route: '/platform/lead-templates', live: true },
  ]},
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke test on sim**

Reload app → Platform tab. Expected: "Support analytics" appears under Support; a new "Notifications" group shows "Notifications log" + "Lead templates". Tap each → the correct screen opens (no "Soon" badge, no dead tap). Screenshot.

- [ ] **Step 4: Commit**

```bash
git add "apps/mobile/app/(tabs)/platform.tsx"
git commit -m "feat(mobile): surface analytics + notifications screens on Platform tab"
```

---

## Task 7: Final verification + push

- [ ] **Step 1: Full typecheck + doctor**

```bash
cd apps/mobile && npx tsc --noEmit && npx expo-doctor
```
Expected: tsc clean; expo-doctor shows no NEW issues (pre-existing version notes acceptable if unchanged).

- [ ] **Step 2: Full smoke pass**

Reload the app and walk all 4 new screens + the trace drill-down once more. Confirm real data renders on each and the Send-test action works. Screenshot each for the record.

- [ ] **Step 3: Push**

```bash
git push origin main
```
(Note: pushing `main` rebuilds/redeploys the web `company` image — mobile-only changes, harmless but cycles prod, per the established workflow.)

---

## Self-review notes (spec coverage)

- Support Analytics → Task 3. Notifications Log → Task 4. Lead Templates (read + send-test) → Task 5. Observability Trace detail + tappable rows → Task 2. Nav → Task 6. `api.ts` host cleanup → Task 1. Verification → each task + Task 7.
- Deferred per spec (NOT in plan): Stripe key config, template HTML editing, observability charts/waterfall, dashboard charts, leads/tenants CRUD. Optional polish (dashboard leads-by-status, ticket priority/product chips, health namespace chips) intentionally omitted to keep the slice tight — revisit only if desired.
- Two `formatPct` convention checks are flagged inline (Tasks 3 & 4) because the ratio-vs-percentage input convention must be confirmed against a sibling usage; this is a real verification step, not a placeholder.
