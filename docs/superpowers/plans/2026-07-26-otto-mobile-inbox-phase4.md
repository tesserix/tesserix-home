# Otto platform inbox — Phase 4 (tesserix-home mobile admin app)

**Date:** 2026-07-26
**Status:** Plan, ready to implement
**Repo:** `tesserix-home` ONLY
**Spec:** `slm-support-platform/docs/superpowers/specs/2026-07-25-otto-platform-inbox-design.md` (§4 + follow-ups)
**Prior art:** Phase 3 web inbox — `apps/web/app/admin/support/live-chat/page.tsx`, `apps/web/components/admin/support/PlatformLiveChatInbox.tsx`, proxy `apps/web/app/api/admin/otto/[...path]/route.ts` (all live).

---

## Goal

Give Tesserix admins a native (no-WebView) support inbox in the Expo mobile
admin app: browse the cross-product otto queue (waiting / active / closed),
accept a chat, reply, and close it — reaching the already-live platform proxy
`/api/admin/otto/*` with the app's existing bearer token, and staying live via
polling (WebSocket as an optional accelerator).

## Architecture

```
Expo mobile (apps/mobile)
  lib/otto-contracts.ts   RN wire types (mirror otto Go models)
  lib/otto-hooks.ts       TanStack Query hooks over the `plat` axios client
  lib/otto-realtime.ts    (optional) WS accelerator → invalidates queries
  app/platform/live-chat/index.tsx   inbox list (tabs + product filter)
  app/platform/live-chat/[id].tsx    thread (history + accept/reply/close)
        │  bearer  (Authorization: Bearer <tx session>)
        ▼
tesserix-home web (apps/web)  /api/admin/otto/[...path]  ── EXISTING, unchanged
        │  X-Internal-Auth + X-User-Id (session.sub)
        ▼
otto  /api/v1/platform/otto/*  ── EXISTING, unchanged
WebSocket: wss://tesserix.app/api/v1/platform/otto/{ws,conversations/:id/ws}
        (Istio routes WS straight to otto, bypassing the Next proxy — EXISTING)
```

Data path reuses the app's `plat` client (`apps/mobile/lib/api.ts`), which
prefixes `/api/admin` and attaches the bearer. So `plat.get('/otto/...')` hits
`/api/admin/otto/...`. No new client, no new auth.

## Stack

Expo SDK 56 / React Native 0.85 / React 19, expo-router 56 (file-based routing;
`useIsFocused` for focus-gated polling), TanStack Query v5, axios, TypeScript
6.0 (strict: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`).
No NativeWind — styling via `lib/theme.ts` + `components/kit.tsx`. Shared
helpers from `@tesserix/homechef-shared` (`formatRelative`, `titleCase`).

## Global Constraints

- **Branch:** `feat/otto-mobile-inbox` off `main` in **tesserix-home only**.
  The repo is currently on a different branch — start clean:
  ```bash
  cd tesserix-home
  git checkout main && git pull --ff-only origin main
  git checkout -b feat/otto-mobile-inbox
  ```
- **Git identity (set once, before any commit):**
  ```bash
  git config user.name "sam123ben"
  git config user.email "samyak.rout@gmail.com"
  ```
- **No AI references** anywhere — commit messages, code comments, PR text. No
  `Co-Authored-By`.
- **Verify (every task):** `pnpm --filter mobile typecheck` (the mobile
  `package.json` `"name"` is `mobile`; the script is `tsc --noEmit`). Expected:
  the `> tsc --noEmit` banner, no error lines, exit 0. A `.npmrc`
  `${NODE_AUTH_TOKEN}` WARN is pre-existing noise — ignore it.
- **Concurrent sessions:** other sessions may touch this repo. **Before each
  commit** run `git status` and `git log --oneline -1`; commit ONLY the files
  this plan creates/edits (list them explicitly on `git add`). If you find
  foreign uncommitted changes to files you did not touch, STOP and surface them
  — do not `git add -A`, do not stash someone else's work.
- **Ship:** push `feat/otto-mobile-inbox` → PR → merge to `main` → CI builds the
  web image. **This change touches mobile files only — no web/middleware/API
  change (see Deliverable A), so NO ArgoCD company web promote is required.**
  The mobile app reaches users through the **user's own dev/EAS build flow**
  (batched per the "batch mobile releases" convention), **not** via CI
  auto-deploy. State this in the PR body.

---

## Deliverable A — Bearer/CSRF exemption: **NO CODE CHANGE (verified no-op)**

**Verdict:** the mobile bearer writes to `/api/admin/otto/*` (POST accept /
messages / close / ws-ticket) are already exempt from the CSRF origin check by
**two independent, already-live mechanisms**. No `middleware.ts` edit is needed.

**Evidence 1 — the bearer-CSRF exemption already exists and is already wired.**
`apps/web/middleware.ts` line 88 calls `evaluateCsrf(request)`; that function
(`apps/web/lib/security/csrf.ts`) already imports `bearerToken` (line 1 — the
"already imported" pattern the Phase-3 reviewer flagged) and contains:
```ts
const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? "tx_session";
const cookieHeader = request.headers.get("cookie") ?? "";
const hasSessionCookie = new RegExp(`(?:^|;\\s*)${sessionCookieName}=`).test(cookieHeader);
if (!hasSessionCookie && bearerToken(request.headers.get("authorization"))) {
  return { blocked: false };   // bearer + no cookie ⇒ CSRF does not apply
}
```
The mobile app authenticates with `Authorization: Bearer <token>` held in
SecureStore and carries **no** `.tesserix.app` session cookie (it never does the
browser cookie login). So `hasSessionCookie === false` and a bearer is present
⇒ the exemption returns `blocked: false` for every mutating `/api/admin/otto/*`
call. `/api/admin/otto/*` is a mutating API route and is **not** under
`/api/internal/`, so it reaches exactly this branch.

**Evidence 2 — the mobile Origin workaround would pass the check anyway.**
`apps/mobile/lib/api.ts` line 31 sets `cfg.headers.Origin = BASE` on every
request (`BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://tesserix.app'`).
Even if Evidence-1 did not fire, `evaluateCsrf` adds the request `Host`
(`tesserix.app`) to `allowedHostnames`, and `Origin: https://tesserix.app`
(hostname `tesserix.app`) matches — so the origin check passes. The same
workaround already carries the app's existing `/api/admin/*` POSTs (tickets,
announcements, domains, delivery toggles), which are live today.

**Confirm at implementation time (read-only, no change):**
```bash
grep -n "hasSessionCookie" apps/web/lib/security/csrf.ts        # exemption present
grep -n "cfg.headers.Origin = BASE" apps/mobile/lib/api.ts       # origin workaround present
grep -n "startsWith(\"/api/internal/\")" apps/web/lib/security/csrf.ts  # otto is NOT internal ⇒ reaches the bearer branch
```
Deliverable A ships as documentation only — there is nothing to commit for it.

---

## Wire shapes (Deliverable C reference — from otto Go models)

Confirmed against `slm-support-platform/services/otto/internal/conversation/model.go`
and `internal/message/model.go`.

**Conversation** (`GET /conversations`, `GET /conversations/:id`, accept/close
responses). JSON keys we consume: `id`, `case_id`, `tenant_id`, `store_id`,
`status` (`pending|active|closed`), `subject`, `customer{ session_token,
user_id?, name?, email? }`, `assignee?{ user_id, name?, email?, assigned_at }`,
`intake?{ reason, status, dob?, submitted_at }`, `created_at`, `updated_at`,
`last_message_at`, `closed_at?`, `message_count`, `unread_count_staff`. (Wire
also carries `unread_count_customer`, `needs_human`, `last_assistant_message_at`,
`feedback` — ignored; extra fields are fine.)

**Message** (`GET /conversations/:id/messages`, `POST .../messages`): `id`,
`conversation_id`, `sender_type` (`customer|staff|system|assistant`),
`sender_name?`, `body`, `created_at`. (Wire also carries `tenant_id`,
`store_id`, `sender_id` — ignored.)

**Envelopes:** list `{ conversations: [...] }`; single `{ conversation: {...} }`;
history `{ messages: [...] }`; `POST .../messages` → `{ message: {...} }` (201);
`POST .../accept` and `POST .../close` → `{ conversation: {...} }`;
`POST /ws-ticket` and `POST /conversations/:id/ws-ticket` → `{ ticket: "..." }`.

**"mine" (Deliverable C decision):** the mobile app does **not** hold its own
subject. `/api/auth/mobile/session` returns only `{ email, name }`; the auth
context (`apps/mobile/lib/auth.tsx`, `AdminUser`) has only `email`/`name`; the
session JWE is encrypted and cannot be decoded on device. **We therefore never
put the sub on the client.** otto's platform list supports `?assignee=mine`,
which it resolves server-side to the proxy-forwarded `X-User-Id`
(`platform_handler.go` `list()` → `p.AssigneeUserID = c.GetString(auth.CtxUserID)`;
the proxy sets `X-User-Id: session.sub`). So:
- **Active tab is scoped to the signed-in admin:** `?status=active&assignee=mine`.
  Every thread it shows is the admin's own → the thread composer rule reduces to
  "show composer iff `status === 'active'`" (correct without a client sub).
- **Server backstop:** otto's `postMessage` rejects a non-assignee with 403
  `not_assignee` (`admin_handler.go` lines 305-312); a stray POST surfaces a
  toast. The web page needs `currentUserId` (from `getCurrentSession().sub`);
  mobile deliberately avoids that with the server filter → **zero web change.**

**WebSocket:** INCLUDED as one optional hook file (Task 4). It only mints a
ticket and invalidates queries on each frame (no message parsing / no outbox);
polling is the guaranteed baseline. Full mark8ly-style WS→SSE→outbox is a
stated follow-up.

---

## Task 1 — Data layer: contracts + query hooks

**Files (new):** `apps/mobile/lib/otto-contracts.ts`, `apps/mobile/lib/otto-hooks.ts`

**Interfaces:** the wire types above; `useOttoInbox(params, refetchInterval)`,
`useOttoConversation(id, refetchInterval)`, `useOttoMessages(id, refetchInterval)`,
`useAcceptOtto(id)`, `useSendOttoMessage(id)`, `useCloseOtto(id)`, and the `ok`
query-key factory. `refetchInterval` is passed by the screen (focus-gated).

**Step 1.1 — `apps/mobile/lib/otto-contracts.ts`:**
```ts
// Wire shapes for the cross-tenant otto platform inbox, served by
// tesserix-home's /api/admin/otto/* proxy (→ otto /api/v1/platform/otto/*).
// Fields mirror otto's Go models (services/otto/internal/conversation/model.go
// + message/model.go); extra fields on the wire are ignored.

export type OttoStatus = 'pending' | 'active' | 'closed';
export type OttoSenderType = 'customer' | 'staff' | 'system' | 'assistant';

export interface OttoCustomer {
  name?: string;
  email?: string;
  user_id?: string;
  session_token?: string;
}

export interface OttoAssignee {
  user_id: string;
  name?: string;
  email?: string;
  assigned_at?: string;
}

export interface OttoIntake {
  reason: string;
  status: string;
  dob?: string;
  submitted_at?: string;
}

export interface OttoConversation {
  id: string;
  case_id: string;
  tenant_id: string;
  store_id?: string;
  status: OttoStatus;
  subject?: string;
  customer: OttoCustomer;
  assignee?: OttoAssignee;
  intake?: OttoIntake;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  closed_at?: string;
  message_count: number;
  unread_count_staff: number;
}

export interface OttoMessage {
  id: string;
  conversation_id: string;
  sender_type: OttoSenderType;
  sender_name?: string;
  body: string;
  created_at: string;
}

export interface OttoConversationsResponse {
  conversations: OttoConversation[];
}
export interface OttoConversationResponse {
  conversation: OttoConversation;
}
export interface OttoMessagesResponse {
  messages: OttoMessage[];
}
export interface OttoMessageResponse {
  message: OttoMessage;
}
export interface OttoWsTicketResponse {
  ticket: string;
}

// id -> friendly product name. Ported from the web PlatformLiveChatInbox
// TENANT_LABELS so mobile badges match web. Unknown tenant ids fall back to
// the raw id in the badge.
export const OTTO_TENANT_LABELS: Record<string, string> = {
  platform: 'Tesserix',
  homechef: 'HomeChef',
  fanzone: 'FanZone',
  mark8ly: 'mark8ly',
  horoscope: 'Horoscope',
  stockpilot: 'StockPilot',
  scrapper: 'Social Scraper',
  gameverse: 'GameVerse',
  'mp-customer': 'Marketplace',
};

export function ottoTenantLabel(id: string): string {
  return OTTO_TENANT_LABELS[id] ?? id;
}
```

**Step 1.2 — `apps/mobile/lib/otto-hooks.ts`:**
```ts
// TanStack Query hooks over the otto platform inbox, via the `plat` client
// (/api/admin prefix → /api/admin/otto/*). The inbox list and each open
// thread poll while their screen is focused; mutations invalidate the
// affected keys so the queue and thread stay consistent.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plat } from './api';
import type {
  OttoConversationResponse,
  OttoConversationsResponse,
  OttoMessageResponse,
  OttoMessagesResponse,
  OttoStatus,
} from './otto-contracts';

export interface OttoInboxParams {
  status: OttoStatus;
  tenant?: string;
  assignee?: 'mine';
}

export const ok = {
  inbox: (p: OttoInboxParams) => ['otto', 'inbox', p] as const,
  conversation: (id: string) => ['otto', 'conversation', id] as const,
  messages: (id: string) => ['otto', 'messages', id] as const,
};

export function useOttoInbox(p: OttoInboxParams, refetchInterval: number | false) {
  return useQuery({
    queryKey: ok.inbox(p),
    queryFn: () =>
      plat.get<OttoConversationsResponse>('/otto/conversations', {
        status: p.status,
        tenant: p.tenant || undefined,
        assignee: p.assignee || undefined,
      }),
    refetchInterval,
  });
}

export function useOttoConversation(id: string, refetchInterval: number | false) {
  return useQuery({
    queryKey: ok.conversation(id),
    queryFn: () => plat.get<OttoConversationResponse>(`/otto/conversations/${id}`),
    enabled: !!id,
    refetchInterval,
  });
}

export function useOttoMessages(id: string, refetchInterval: number | false) {
  return useQuery({
    queryKey: ok.messages(id),
    queryFn: () => plat.get<OttoMessagesResponse>(`/otto/conversations/${id}/messages`),
    enabled: !!id,
    refetchInterval,
  });
}

export function useAcceptOtto(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => plat.post<OttoConversationResponse>(`/otto/conversations/${id}/accept`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ['otto', 'inbox'] });
    },
  });
}

export function useSendOttoMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      plat.post<OttoMessageResponse>(`/otto/conversations/${id}/messages`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
      qc.invalidateQueries({ queryKey: ['otto', 'inbox'] });
    },
  });
}

export function useCloseOtto(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => plat.post<OttoConversationResponse>(`/otto/conversations/${id}/close`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ['otto', 'inbox'] });
    },
  });
}
```

**Notes:** `plat.get(path, params)` drops `undefined` params (axios). `id` is a
UUID (URL-safe) so raw interpolation matches the existing `platform-hooks.ts`
ticket pattern; the proxy re-encodes each path segment. Partial key
`['otto', 'inbox']` invalidates every tab/tenant variant at once.

**Verify:** `pnpm --filter mobile typecheck` → exit 0.

**Commit:**
```bash
git status && git log --oneline -1                     # concurrency check
git add apps/mobile/lib/otto-contracts.ts apps/mobile/lib/otto-hooks.ts
git commit -m "feat(mobile): otto platform inbox data layer (types + query hooks)"
```

---

## Task 2 — Inbox list screen + platform nav entry

**Files:** new `apps/mobile/app/platform/live-chat/index.tsx`; edit
`apps/mobile/app/(tabs)/platform.tsx`. (`app/platform/_layout.tsx` is a
`Stack` with `headerShown:false`; expo-router auto-registers nested routes, no
layout edit needed.)

**Behaviour:** three tabs — Waiting=`?status=pending`, Active=`?status=active&assignee=mine`,
Closed=`?status=closed`; a horizontal product-filter chip row (`?tenant=`);
per-row unread badge (`unread_count_staff`) + product badge (`ottoTenantLabel`);
pull-to-refresh; 10s poll while focused. Rows push `/platform/live-chat/:id`.

**Step 2.1 — create `apps/mobile/app/platform/live-chat/index.tsx`:**
```tsx
// Otto platform inbox — the cross-product support queue. Waiting (pending,
// unclaimed), Active (my accepted chats), and Closed tabs; a product filter;
// per-row unread badge + product (tenant) badge. Polls every 10s while focused.

import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router, useIsFocused } from 'expo-router';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  EmptyState,
  FilterChips,
  ListRow,
  LoadingRows,
  Screen,
  ScreenHeader,
} from '../../../components/kit';
import { space } from '../../../lib/theme';
import { useOttoInbox, type OttoInboxParams } from '../../../lib/otto-hooks';
import { ottoTenantLabel, type OttoConversation } from '../../../lib/otto-contracts';

type TabKey = 'waiting' | 'active' | 'closed';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'active', label: 'Active' },
  { key: 'closed', label: 'Closed' },
];

const TENANT_FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All products' },
  { key: 'platform', label: 'Tesserix' },
  { key: 'homechef', label: 'HomeChef' },
  { key: 'fanzone', label: 'FanZone' },
  { key: 'mark8ly', label: 'mark8ly' },
  { key: 'horoscope', label: 'Horoscope' },
  { key: 'stockpilot', label: 'StockPilot' },
  { key: 'scrapper', label: 'Social Scraper' },
  { key: 'gameverse', label: 'GameVerse' },
  { key: 'mp-customer', label: 'Marketplace' },
];

function tabToParams(tab: TabKey, tenant: string): OttoInboxParams {
  const t = tenant || undefined;
  if (tab === 'waiting') return { status: 'pending', tenant: t };
  if (tab === 'active') return { status: 'active', tenant: t, assignee: 'mine' };
  return { status: 'closed', tenant: t };
}

function emptyBody(tab: TabKey): string {
  if (tab === 'waiting') return 'No customers are waiting right now.';
  if (tab === 'active') return 'You have no active chats.';
  return 'No closed conversations.';
}

export default function OttoInboxScreen() {
  const [tab, setTab] = useState<TabKey>('waiting');
  const [tenant, setTenant] = useState('');
  const focused = useIsFocused();

  const params = useMemo(() => tabToParams(tab, tenant), [tab, tenant]);
  const q = useOttoInbox(params, focused ? 10_000 : false);

  const rows = q.data?.conversations ?? [];

  return (
    <Screen>
      <ScreenHeader
        title="Live chat"
        subtitle="Support across every product"
        right={<BackButton onPress={() => router.back()} />}
      />
      <View style={{ paddingBottom: space[2] }}>
        <FilterChips options={TABS} value={tab} onChange={setTab} />
      </View>
      <View style={{ paddingBottom: space[3] }}>
        <FilterChips options={TENANT_FILTERS} value={tenant} onChange={setTenant} />
      </View>
      {q.isLoading ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing here" body={emptyBody(tab)} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingHorizontal: space[4], gap: 8, paddingBottom: space[10] }}
          refreshing={q.isRefetching}
          onRefresh={() => q.refetch()}
          renderItem={({ item }) => <ConversationRow conv={item} />}
        />
      )}
    </Screen>
  );
}

function ConversationRow({ conv }: { conv: OttoConversation }) {
  const who = conv.customer?.name || conv.customer?.email || 'Anonymous';
  const reason = conv.intake?.reason ? titleCase(conv.intake.reason) : conv.subject || 'Support chat';
  const unread = conv.unread_count_staff > 0;
  return (
    <ListRow
      title={who}
      subtitle={`${reason} · ${formatRelative(conv.last_message_at)}`}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {unread ? <Badge label={String(conv.unread_count_staff)} tone="danger" /> : null}
          <Badge label={ottoTenantLabel(conv.tenant_id)} tone="info" />
        </View>
      }
      onPress={() => router.push(`/platform/live-chat/${conv.id}`)}
    />
  );
}
```

**Step 2.2 — edit `apps/mobile/app/(tabs)/platform.tsx`.** Add `MessageSquare`
to the lucide import, and a "Live chat" item as the first entry of the Support
group.

Change the import line:
```ts
  Ticket, Megaphone, Activity, HeartPulse, Users, Database, Globe, Inbox, ShieldAlert, Trash2, ScrollText, BarChart3, Mail, FileText,
} from 'lucide-react-native';
```
to:
```ts
  Ticket, Megaphone, Activity, HeartPulse, Users, Database, Globe, Inbox, ShieldAlert, Trash2, ScrollText, BarChart3, Mail, FileText, MessageSquare,
} from 'lucide-react-native';
```
Change the Support group opener:
```ts
  { group: 'Support', items: [
    { title: 'Platform tickets', sub: 'Cross-product support', icon: Ticket, route: '/platform/tickets', live: true },
```
to:
```ts
  { group: 'Support', items: [
    { title: 'Live chat', sub: 'Customer support inbox', icon: MessageSquare, route: '/platform/live-chat', live: true },
    { title: 'Platform tickets', sub: 'Cross-product support', icon: Ticket, route: '/platform/tickets', live: true },
```

**Verify:** `pnpm --filter mobile typecheck` → exit 0.

**Commit:**
```bash
git status && git log --oneline -1
git add apps/mobile/app/platform/live-chat/index.tsx "apps/mobile/app/(tabs)/platform.tsx"
git commit -m "feat(mobile): otto inbox list screen + platform nav entry"
```

---

## Task 3 — Thread screen (accept / reply / close)

**File (new):** `apps/mobile/app/platform/live-chat/[id].tsx`

**Behaviour:** header = customer name + `case_id`; badge row = product + intake
reason + status; intake status shown as a banner. Message history (system
messages centered; staff right / customer left bubbles), sorted ascending.
`status==='pending'` → **Accept** button; `status==='active'` → composer + a
**Close** action (active threads reached here are the admin's own — the Active
tab is `assignee=mine`); `status==='closed'` → read-only banner. 3s poll while
focused. Errors → `Alert` via `apiError`.

**Step 3.1 — create `apps/mobile/app/platform/live-chat/[id].tsx`:**
```tsx
// Otto thread — full message history with the product/reason/case-id header,
// an Accept button while pending, a composer + Close action while active
// (these threads are the admin's own — the Active tab is scoped to the
// signed-in staff via ?assignee=mine), and a read-only banner once closed.
// Polls every 3s while focused.

import { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { formatRelative, titleCase } from '@tesserix/homechef-shared';
import {
  Badge,
  BackButton,
  Banner,
  Button,
  EmptyState,
  LoadingRows,
  Screen,
  ScreenHeader,
  type Tone,
} from '../../../components/kit';
import { apiError } from '../../../lib/api';
import { usePalette, radius, space, text } from '../../../lib/theme';
import {
  useAcceptOtto,
  useCloseOtto,
  useOttoConversation,
  useOttoMessages,
  useSendOttoMessage,
} from '../../../lib/otto-hooks';
import { ottoTenantLabel, type OttoMessage, type OttoStatus } from '../../../lib/otto-contracts';

function statusLabel(s: OttoStatus): string {
  if (s === 'pending') return 'Waiting';
  if (s === 'active') return 'Active';
  return 'Closed';
}

function statusTone(s: OttoStatus): Tone {
  if (s === 'pending') return 'warning';
  if (s === 'active') return 'success';
  return 'neutral';
}

export default function OttoThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const focused = useIsFocused();
  const p = usePalette();

  const convQ = useOttoConversation(id, focused ? 3_000 : false);
  const msgsQ = useOttoMessages(id, focused ? 3_000 : false);
  const accept = useAcceptOtto(id);
  const send = useSendOttoMessage(id);
  const close = useCloseOtto(id);

  const [draft, setDraft] = useState('');

  const conv = convQ.data?.conversation;
  const messages = useMemo(
    () => [...(msgsQ.data?.messages ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [msgsQ.data],
  );

  if (convQ.isLoading && !conv) {
    return (
      <Screen>
        <ScreenHeader title="Chat" right={<BackButton onPress={() => router.back()} />} />
        <LoadingRows />
      </Screen>
    );
  }
  if (!conv) {
    return (
      <Screen>
        <ScreenHeader title="Chat" right={<BackButton onPress={() => router.back()} />} />
        <EmptyState title="Conversation not found" body="It may have been removed." />
      </Screen>
    );
  }

  const who = conv.customer?.name || conv.customer?.email || 'Anonymous';

  function doAccept() {
    accept.mutate(undefined, { onError: (e) => Alert.alert('Could not accept', apiError(e)) });
  }
  function doSend() {
    const body = draft.trim();
    if (!body) return;
    send.mutate(body, {
      onSuccess: () => setDraft(''),
      onError: (e) => Alert.alert('Could not send', apiError(e)),
    });
  }
  function doClose() {
    Alert.alert('Close chat', 'Close this conversation? The customer can no longer reply.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close',
        style: 'destructive',
        onPress: () => close.mutate(undefined, { onError: (e) => Alert.alert('Could not close', apiError(e)) }),
      },
    ]);
  }

  return (
    <Screen>
      <ScreenHeader title={who} subtitle={conv.case_id} right={<BackButton onPress={() => router.back()} />} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space[4], paddingBottom: space[3] }}>
        <Badge label={ottoTenantLabel(conv.tenant_id)} tone="info" />
        {conv.intake?.reason ? <Badge label={titleCase(conv.intake.reason)} tone="neutral" /> : null}
        <Badge label={statusLabel(conv.status)} tone={statusTone(conv.status)} />
      </View>

      {conv.intake?.status ? <Banner text={conv.intake.status} tone="info" /> : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={80}
      >
        {messages.length === 0 ? (
          <View style={{ flex: 1 }}>
            <EmptyState title="No messages yet" />
          </View>
        ) : (
          <FlatList
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[4], gap: 8 }}
            renderItem={({ item }) => <MessageBubble msg={item} />}
          />
        )}

        {conv.status === 'pending' ? (
          <View style={{ padding: space[4] }}>
            <Button label="Accept chat" onPress={doAccept} loading={accept.isPending} />
          </View>
        ) : conv.status === 'active' ? (
          <View style={{ padding: space[4], gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Write a reply…"
              placeholderTextColor={p.mutedForeground}
              multiline
              style={[styles.input, { borderColor: p.border, color: p.foreground, backgroundColor: p.muted }]}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button label="Send" onPress={doSend} loading={send.isPending} disabled={!draft.trim() || send.isPending} />
              </View>
              <Button label="Close" variant="secondary" tone="danger" onPress={doClose} loading={close.isPending} />
            </View>
          </View>
        ) : (
          <Banner text="This conversation is closed." tone="neutral" />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function MessageBubble({ msg }: { msg: OttoMessage }) {
  const p = usePalette();
  const mine = msg.sender_type === 'staff';
  if (msg.sender_type === 'system') {
    return (
      <Text style={[text.caption, { color: p.mutedForeground, textAlign: 'center', marginVertical: 4 }]}>
        {msg.body}
      </Text>
    );
  }
  return (
    <View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '82%',
        backgroundColor: mine ? p.primary : p.muted,
        borderRadius: radius.lg,
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      {!mine ? (
        <Text style={[text.caption, { color: p.mutedForeground, marginBottom: 2 }]}>
          {msg.sender_name || 'Customer'}
        </Text>
      ) : null}
      <Text style={{ fontFamily: 'InterTight', fontSize: 15, lineHeight: 21, color: mine ? p.primaryForeground : p.foreground }}>
        {msg.body}
      </Text>
      <Text
        style={{
          fontFamily: 'InterTight',
          fontSize: 11,
          color: mine ? p.primaryForeground : p.mutedForeground,
          opacity: 0.7,
          marginTop: 4,
          textAlign: 'right',
        }}
      >
        {formatRelative(msg.created_at)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 72,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontFamily: 'InterTight',
    fontSize: 15,
    textAlignVertical: 'top',
  },
});
```

**Verify:** `pnpm --filter mobile typecheck` → exit 0. At this point the feature
is fully functional on polling alone.

**Commit:**
```bash
git status && git log --oneline -1
git add "apps/mobile/app/platform/live-chat/[id].tsx"
git commit -m "feat(mobile): otto thread screen with accept, reply, and close"
```

---

## Task 4 — Optional WebSocket accelerator

**OPTIONAL.** Tasks 1-3 are complete and shippable on polling. This task layers
live push on top: a single hook file mints a ticket via the proxy, opens the
platform WS directly to otto, and invalidates queries on each frame. If the WS
never connects, polling still covers everything. **To defer WS:** skip this
task entirely — do not create `otto-realtime.ts` and do not apply the two screen
edits below.

**Files:** new `apps/mobile/lib/otto-realtime.ts`; edit
`apps/mobile/app/platform/live-chat/index.tsx` and `.../[id].tsx`.

**Step 4.1 — create `apps/mobile/lib/otto-realtime.ts`:**
```ts
// Optional realtime accelerator for the otto inbox + threads. Polling
// (see otto-hooks.ts) is the guaranteed baseline; this hook only *speeds up*
// updates: it mints a short-TTL ticket via the authenticated proxy, opens the
// platform WebSocket DIRECTLY to otto (Istio routes /api/v1/platform/otto/*/ws
// past the Next.js proxy), and calls onFrame() on every inbound frame so the
// screen can invalidate its queries. If the ticket mint or the socket fails,
// nothing breaks — polling still covers the screen. No message parsing, no
// outbox: those live in the mark8ly kit and are a follow-up if needed.

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { plat } from './api';
import type { OttoWsTicketResponse } from './otto-contracts';

const BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://tesserix.app';
const WS_BASE = BASE.replace(/^http/i, 'ws').replace(/\/+$/, '');
const MAX_BACKOFF_MS = 15_000;

export interface OttoSocketOpts {
  enabled: boolean;
  onFrame: () => void;
}

// useOttoSocket is the shared engine: mint a ticket at `mintPath` (a `plat`
// path, e.g. '/otto/ws-ticket'), connect to `wsPath` (an otto path under
// /api/v1/platform/otto) with the ticket appended, reconnect with backoff,
// and reconnect when the app returns to the foreground.
function useOttoSocket(mintPath: string, wsPath: string, { enabled, onFrame }: OttoSocketOpts) {
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;

    const clearTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      attempts += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1));
      clearTimer();
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    async function connect() {
      if (stopped) return;
      let ticket: string;
      try {
        const res = await plat.post<OttoWsTicketResponse>(mintPath);
        ticket = res.ticket;
      } catch {
        scheduleReconnect();
        return;
      }
      if (stopped || !ticket) return;
      try {
        ws = new WebSocket(`${WS_BASE}${wsPath}?ticket=${encodeURIComponent(ticket)}`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempts = 0;
      };
      ws.onmessage = () => onFrameRef.current();
      ws.onerror = () => {};
      ws.onclose = () => {
        ws = null;
        if (!stopped) scheduleReconnect();
      };
    }

    const onAppState = (s: AppStateStatus) => {
      if (s === 'active' && !ws) {
        clearTimer();
        attempts = 0;
        void connect();
      }
    };
    const sub = AppState.addEventListener('change', onAppState);

    void connect();

    return () => {
      stopped = true;
      clearTimer();
      sub.remove();
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }, [enabled, mintPath, wsPath]);
}

export function useOttoInboxSocket(opts: OttoSocketOpts) {
  useOttoSocket('/otto/ws-ticket', '/api/v1/platform/otto/ws', opts);
}

export function useOttoThreadSocket(id: string, opts: OttoSocketOpts) {
  useOttoSocket(
    `/otto/conversations/${id}/ws-ticket`,
    `/api/v1/platform/otto/conversations/${id}/ws`,
    opts,
  );
}
```

**Step 4.2 — wire into `index.tsx`.** Add two imports and one hook call.

Add after the existing `react-native` import:
```tsx
import { useQueryClient } from '@tanstack/react-query';
```
Add after the `../../../lib/otto-contracts` import:
```tsx
import { useOttoInboxSocket } from '../../../lib/otto-realtime';
```
In `OttoInboxScreen`, after `const focused = useIsFocused();` add:
```tsx
  const qc = useQueryClient();
```
After `const q = useOttoInbox(params, focused ? 10_000 : false);` add:
```tsx
  useOttoInboxSocket({
    enabled: focused,
    onFrame: () => qc.invalidateQueries({ queryKey: ['otto', 'inbox'] }),
  });
```

**Step 4.3 — wire into `[id].tsx`.** Add the `ok` key factory to the otto-hooks
import, add two imports, and one hook call.

Change the otto-hooks import first line from:
```tsx
import {
  useAcceptOtto,
```
to:
```tsx
import {
  ok,
  useAcceptOtto,
```
Add after the `@tesserix/homechef-shared` import:
```tsx
import { useQueryClient } from '@tanstack/react-query';
```
Add after the `../../../lib/otto-contracts` import:
```tsx
import { useOttoThreadSocket } from '../../../lib/otto-realtime';
```
In `OttoThreadScreen`, after `const p = usePalette();` add:
```tsx
  const qc = useQueryClient();
```
After the `const [draft, setDraft] = useState('');` line add:
```tsx
  useOttoThreadSocket(id, {
    enabled: focused && !!id,
    onFrame: () => {
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
    },
  });
```

**Verify:** `pnpm --filter mobile typecheck` → exit 0.

**Commit:**
```bash
git status && git log --oneline -1
git add apps/mobile/lib/otto-realtime.ts apps/mobile/app/platform/live-chat/index.tsx "apps/mobile/app/platform/live-chat/[id].tsx"
git commit -m "feat(mobile): optional websocket accelerator for the otto inbox"
```

---

## Manual smoke (per spec §Testing "mobile")

Run the app against prod (`EXPO_PUBLIC_API_BASE=https://tesserix.app`), sign in
as an admin: Platform tab → Support → **Live chat**. Confirm Waiting lists
pending chats across products with correct product badges; Accept moves a chat
to Active and reveals the composer; a reply appears in the customer widget;
Close moves it to Closed (read-only). Toggle a product chip and pull-to-refresh.
With Task 4, replies from the customer appear within ~1s; kill the network and
confirm polling still recovers messages within ~3-10s.

---

## Self-review

**Coverage.**
- **A (CSRF):** resolved as a verified NO-OP with two independent proofs
  (csrf.ts bearer exemption already imported/wired; api.ts Origin workaround) +
  read-only confirm greps. No middleware edit.
- **B (screens):** inbox list (waiting[pending]/active/closed tabs, product
  chips, unread badge = `unread_count_staff`, tenant badge via `ottoTenantLabel`
  = same map as web, pull-to-refresh, 10s focus poll) ✓; thread (history,
  accept when pending, composer when active-and-mine, close, product/reason/
  case-id header + intake-status banner, 3s focus poll) ✓; nav entry added to
  `app/(tabs)/platform.tsx` Support group ✓; data via `plat.*` (`/api/admin`
  prefix) ✓; polling primary + WS optional in one hook file ✓.
- **C (wire shapes + mine):** all types mirror the Go models; envelopes exact
  (`{conversations}`/`{conversation}`/`{messages}`/`{message}` 201/`{ticket}`);
  "mine" resolved server-side via `?assignee=mine` (no client sub; zero web
  change), with otto's `not_assignee` 403 as backstop.

**Placeholder scan.** No `TBD`, no "similar to", no stubbed functions — every
file is complete and was compiled (see below). All routes, envelope keys, and
`plat` paths are concrete.

**Type consistency.** `OttoStatus`/`OttoSenderType` unions match otto's Go
consts. `plat.get(path, params)` and `plat.post(path, body?)` signatures match
`apps/mobile/lib/api.ts`. `FilterChips<T>` instantiates as `TabKey` and `string`.
`refetchInterval: number | false` matches TanStack Query v5. `Tone` values
(`info`/`neutral`/`warning`/`success`/`danger`) all exist in `kit.tsx`.
`OTTO_TENANT_LABELS[id] ?? id` satisfies `noUncheckedIndexedAccess`. No unused
imports in any base or WS-wired file.

**Validation performed.** All five files + the nav edit were written to the repo
and `pnpm --filter mobile typecheck` (`tsc --noEmit`) returned **exit 0**, then
reverted (this is a plan). The base screens (Tasks 2-3, no WS) are a strict
subset of the compiled WS-wired versions with the exactly-matching imports
removed, so they compile under `noUnusedLocals`.

**Known limitations / follow-ups (stated, not gold-plated):** Active tab is
mine-scoped, so active chats owned by other admins are not shown on mobile (an
all-active monitoring view is a follow-up); WS is invalidate-only (no message
parse / SSE / durable outbox — the mark8ly kit port is a follow-up); ticket
escalation from a thread (spec decision 3) is deferred with the web (needs a
tickets tenant-model change); push notifications for new waiting chats are a
spec non-goal (future).
```
