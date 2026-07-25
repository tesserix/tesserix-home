# Mobile HomeChef — Sub-slice H1: Trust & Moderation (design)

**Date:** 2026-07-25
**Area:** `apps/mobile` (Expo admin) — HomeChef product parity
**Decomposition:** HomeChef is split into 6 sub-slices (H1–H6). This spec covers **H1 · Trust & Moderation**, the first slice. See the HomeChef audit in the session handoff for the full 6-slice breakdown.

## Goal

Port the web admin's **Chefs & Trust** area (minus Chefs, already live) into the mobile app: the onboarding **Approvals** queue + detail, **Reviews** moderation, and **FSSAI** compliance lockouts. This establishes the HomeChef list → detail → decide pattern and a reusable prompt primitive that H2–H6 reuse.

## Scope

Four screens plus hub wiring:

1. **Approvals list** — `apps/mobile/app/homechef/approvals.tsx`
2. **Approval detail** — `apps/mobile/app/homechef/approvals/[id].tsx`
3. **Reviews** — `apps/mobile/app/homechef/reviews.tsx`
4. **FSSAI** — `apps/mobile/app/homechef/fssai.tsx`

Plus: flip `Approvals`, `Reviews`, `FSSAI` from `live:false` → `live:true` in the hub (`app/homechef/index.tsx`). All three already exist as hub rows — Approvals + FSSAI in the "Operations" group, Reviews in "People & quality" — so this is a flag flip only, no new hub rows.

Non-goals for H1: bulk-approve (dropped for v1 — single-item decide from detail only), and any Chefs-page changes (already shipped).

## Decisions (resolved during brainstorming)

- **Prompt primitive:** build a reusable `PromptSheet` (Modal) + `useConfirm`/`usePrompt` hook mirroring web's `confirm`/`prompt` (title, message, optional text field with `required`/`minLength`/`numeric`/`defaultValue`/`multiline`, confirm/cancel labels, `tone`). Lives in `components/` and is reused by reject/request-info notes, hide reason, and FSSAI reason+days. Chosen over inline panels because the 3-action detail and FSSAI's two-step reason→days prompt are clunky inline, and every later slice (esp. H4 Payments) needs the same primitive.
- **Bulk approve:** dropped for v1. Mobile decides one approval at a time from the detail screen.
- **Reminded / Escalated:** kept as two extra filter chips alongside the 4 status chips; Escalated chip shows a count badge. Per-row reminder chip + bell icon retained.

## Screens

### 1. Approvals list (`approvals.tsx`)

**Data:** `useApprovals(params)` (exists) returns `Paginated<ApprovalRequest>`. Extend its params type to accept `reminded?: 'true'` and `escalated?: 'true'` (web sends these as strings). Add a small `useEscalatedCount()` (calls `useApprovals({ escalated: 'true', page: 1, limit: 1 })` and reads `pagination.total`) for the chip badge.

**Filter chips (single-select, mobile `FilterChips`):**
- `Pending` (`status=pending`), `Info requested` (`status=info_requested`), `Approved` (`status=approved`), `Rejected` (`status=rejected`)
- `Reminded` (`reminded=true`, no status filter), `Escalated` (`escalated=true`, no status filter — chip shows count badge)

Selecting Reminded/Escalated swaps the query param set (drops `status`, adds the cross-cut flag), matching web `listParams`.

**Search:** `SearchField` → `search` param (server-side title/description ILIKE). Debounce as elsewhere in the app (follow existing SearchField usage; chefs.tsx passes raw — match that unless a debounce helper already exists).

**Row (`ListRow` or a small custom card):**
- Title: `a.title || titleCase(a.type)`, with a red bell icon when `reminderLevel(a.reminderCount).showBell` (count ≥ 3).
- Subline: `[a.kitchenName, a.requestedByName].filter(Boolean).join(' · ')`.
- Trailing / meta: priority `Badge` (`priorityTone`: urgent→danger, high→warning, low→neutral, else info); reminder chip when `reminderCount > 0` → label `Escalated` (if red/`escalatedAt`) or `Reminded ×N`, plus `waiting {Xd|Xh}` from `createdAt`; submitted date `formatDateTime(a.createdAt)`.
- Tap → `router.push('/homechef/approvals/' + a.id)`. Forward-ref route: cast `as never` until the detail file exists (codebase convention).

Port `reminderLevel`, `priorityTone`, and `waitedFor` helpers (from web `approvals/page.tsx`) into the mobile screen. Reminder tone on mobile: use a left-accent border or tone dot + chip color (amber/purple/red) — not full-row tint (cleaner on mobile).

**States:** `LoadingRows`, `EmptyState` (Escalated empty → "Nothing escalated — nobody is waiting on us."; otherwise "Nothing in this state."). Pull-to-refresh via `q.refetch()`.

### 2. Approval detail (`approvals/[id].tsx`)

**Data (new hooks):**
- `useApproval(id)` → `GET /approvals/:id` → `ApprovalDetail = ApprovalRequest & { reviewedBy?: ReviewerRef | null }`.
- `useApprovalHistory(id)` → `GET /approvals/:id/history` → `{ data: ApprovalHistoryEntry[] }`.
- Document open: on tap, `GET /approvals/:id/documents/:docId` → `{ url?: string }`, then `Linking.openURL(url)`. Implement as an imperative call (not a query) with a per-doc busy flag, matching web's on-demand fetch.

`ReviewerRef` = `{ firstName?, lastName?, email? }`; `ApprovalHistoryEntry` = `{ id, fromStatus?, toStatus, notes?, createdAt, changedBy?: ReviewerRef|null }`. Port `personName`, `asObject` (normalize JSON-string submittedData → object — critical, prevents the char-grid bug), and `renderValue` helpers from web.

**Render (top → bottom):**
- Back header (`ScreenHeader` + back chevron).
- Title `a.title || titleCase(a.type)`, subtitle `titleCase(a.type)`, status `Badge` (`statusTone`: approved→success, rejected→danger, else warning).
- Warning `Banner`s: `a.kitchenTypeNonHome` → "Submitted kitchen type is NOT a home kitchen…"; `a.fssaiLooksCommercial` → "FSSAI licence looks like a commercial…".
- Description (if present).
- Meta grid: kitchen, requested-by (+ email), priority, submitted, reviewed (if `reviewedAt`), reviewed-by (`personName(a.reviewedBy)`), admin notes.
- **Submitted details:** `Object.entries(asObject(a.submittedData))`, each rendered with `titleCase(key)` + `renderValue(value)` (booleans→Yes/No, arrays→comma list, nested→"Key: value · …").
- **Documents** (`a.documents`, if any): each row `titleCase(d.type ?? 'Document')` + `d.fileName`, a "View" button (busy → "Opening…") that opens the signed URL.
- **History** timeline (if any): `fromStatus → toStatus`, `formatDateTime(createdAt)` · actor, notes.

**Actions** (only when `status === 'pending' || 'info_requested'`), via `PromptSheet`/`useConfirm`:
- **Approve** → `confirm` ("Approve this request? This triggers the related workflow.") → `PUT /approvals/:id/approve` `{ notes: '' }`.
- **Request more info** → `prompt` (multiline, required, "Tell the applicant what's missing.") → `PUT /approvals/:id/request-info` `{ notes }`.
- **Reject** → `prompt` (multiline, required, destructive tone, "Add a note explaining the rejection.") → `PUT /approvals/:id/reject` `{ notes }`.

After any decision: invalidate `qk.approvals` + the detail query and re-render (status flips, actions hide). Use `useAdminAction`-style mutation or a dedicated decide mutation that invalidates both keys.

### 3. Reviews (`reviews.tsx`)

**Data:** `useReviews({ hidden, page, limit })` (exists) → `Paginated<ReviewRow>`. `hidden` is `'true'` for the Hidden view, `''`/omitted for Visible.

**UI:**
- `FilterChips`: `Visible` / `Hidden`.
- Cards: rating `Badge` (`ratingTone`: ≥4 success, ≥3 warning, else danger) showing `r.overallRating?.toFixed(1) ?? '0.0'` + "★"; `formatDateTime(r.createdAt)`; `r.comment || 'No comment'`; if `r.isHidden && r.hiddenReason` → red "Hidden: {reason}" line.
- Action button per card: if hidden → **Unhide** → `PUT /reviews/:id/unhide` (no body); else → **Hide** → `prompt` (multiline, required, destructive, "e.g. abusive language / spam") → `PUT /reviews/:id/hide` `{ reason }`.
- Mutations via `useAdminAction(qk.reviews({}))` (method `put`), or a thin wrapper; invalidate `['hc','reviews']`.
- `LoadingRows` / `EmptyState` ("No reviews."). Pull-to-refresh.

### 4. FSSAI (`fssai.tsx`)

**Data (new hooks):**
- `useFssaiLocked()` → `GET /chefs/fssai-locked` → `FSSAILockResponse { lockedCount, overriddenCount, missingExpiryCount, locked: FSSAILockedChef[], overridden: FSSAILockedChef[] }`.
- Backfill: `GET /fssai-expiry-backfill` (dry-run list) and `POST /fssai-expiry-backfill` (send confirm-licence push) → `BackfillResponse { count, chefs: BackfillChef[], executed, notified }`. `BackfillChef = { chefId, userId, businessName }`. Implement get as on-demand (button-triggered), post as a mutation.

**UI:**
- Header summary: `{lockedCount} locked · {overriddenCount} overridden`.
- Error/notice `Banner`s.
- **Missing-expiry backfill panel** (only when `missingExpiryCount > 0`): "{n} chef(s) have no FSSAI expiry on record." + `View` (toggles the dry-run list, lazy-fetched once) + `Notify` (confirm → POST → notice "Confirm-licence push sent to {notified} chef(s).").
- **Locked section** (`data.locked`): per chef — `businessName`, `Expiry {formatDate(fssaiExpiry) || 'unknown'} · {daysSinceExpiry}d expired`, `Locked` badge (danger), **Grant override** button → two-step prompt: (1) reason (multiline, required, `minLength: 10`), (2) days (numeric, required, default "7", validate integer 1–30) → `POST /chefs/:chefId/fssai-override` `{ reason, days }`.
- **Overridden section** (`data.overridden`): per chef — `businessName`, `Until {formatDate(overrideUntil) || '—'} · {overrideReason}`, `Override active` badge (info), **Clear** button → confirm (destructive) → `DELETE /chefs/:chefId/fssai-override`.
- Invalidate `['hc','fssai-locked']` after any override change.

## Reusable prompt primitive

New file `apps/mobile/components/prompt.tsx` (or a `PromptSheet` export added to a new module — keep kit.tsx from growing past its budget):

- `PromptProvider` mounted once (in the root layout) holding a single `Modal`.
- `useConfirm()` returns `{ confirm(opts), prompt(opts) }` as promises resolving to `boolean` (confirm) / `string | null` (prompt, null on cancel).
- `confirm(opts)`: `{ title, message?, confirmLabel?, cancelLabel?, tone? }`.
- `prompt(opts)`: `{ title, message?, label?, placeholder?, defaultValue?, multiline?, required?, minLength?, numeric?, confirmLabel?, tone? }`. Enforces `required`/`minLength`/`numeric` inline (disable confirm or show inline error) before resolving.
- Styling from `lib/theme` (`usePalette`/`space`/`radius`/`text`); destructive `tone` uses the danger palette on the confirm button.

This mirrors web `@/components/admin/confirm-dialog` `useConfirm`, so porting each web action is a near-mechanical translation.

## Data-layer summary (`lib/hooks.ts`)

Add to `qk`: `approval: (id) => ['hc','approval',id]`, `approvalHistory: (id) => ['hc','approval-history',id]`, `fssaiLocked: ['hc','fssai-locked']`.

New/changed hooks:
- Extend `useApprovals` param type: `reminded?: string; escalated?: string`.
- `useApproval(id)`, `useApprovalHistory(id)`, `useEscalatedCount()`.
- `useApproveDecision()` (or reuse `useAdminAction`) — `PUT /approvals/:id/{action}` `{ notes }`, invalidates `qk.approvals` + `qk.approval(id)`.
- `openApprovalDocument(id, docId)` helper — imperative `hc.get('/approvals/:id/documents/:docId')` → `Linking.openURL`.
- `useFssaiLocked()`, backfill get helper + `useNotifyFssaiBackfill()` mutation, FSSAI override grant/clear via `useAdminAction(['hc','fssai-locked'])`.
- Reviews hide/unhide via `useAdminAction(qk.reviews({}))`.

**Exact wire shapes** (`ApprovalRequest` full field list incl. `reminderCount`, `escalatedAt`, `lastRemindedAt`, `kitchenTypeNonHome`, `fssaiLooksCommercial`, `documents`, `submittedData`; `ReviewRow`; `FSSAILockResponse`/`FSSAILockedChef`) come from `@tesserix/homechef-shared`. A general-purpose agent extracts and confirms these from the shared package + Go handler references **before** the plan is written, so plan tasks carry real types, not placeholders.

## Testing & gate

No RN unit-test runner exists. Gate = `pnpm --filter @tesserix/homechef-shared build` (refresh dist so tsc sees format exports) then `cd apps/mobile && npx tsc --noEmit`. Multi-stage code review per SDD (per-task reviewer + whole-branch review). Device smoke-test against prod is the user's step (needs their real Google login on the sim).

## Execution

Per the established cycle: this spec → `superpowers:writing-plans` (concrete, no-placeholder plan, after the API-shape extraction agent) → `superpowers:subagent-driven-development` (fresh implementer + task reviewer per task; whole-branch review at end). Commit directly to `main`, single-line messages, no signatures.

### Suggested task order (for the plan)
1. `PromptSheet` primitive + `useConfirm`/`usePrompt` + mount provider in root layout.
2. `lib/hooks.ts` additions (all new hooks + param extensions + doc-open helper).
3. Reviews screen (simplest full CRUD-ish screen — validates hooks + prompt).
4. FSSAI screen (two-step prompt + backfill).
5. Approvals list (filter chips incl. triage + escalated count).
6. Approval detail (submitted-data normalization, documents, history, decide actions).
7. Hub wiring (flip `live` flags) + gate.
