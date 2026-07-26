# Mobile HomeChef — Sub-slice H6: Settings & Mediation (design)

**Date:** 2026-07-26
**Area:** `apps/mobile` (Expo admin) — HomeChef product parity
**Decomposition:** HomeChef → 6 sub-slices. H1 `64dc55d`, H2 `3c9a0a7`, H3 `a301a9d`, H4 `0dcf351`, H5 Part 1 `b5abd6f`, H5 Part 2 `ee3d983..e484e1e` (rebased, pushed as `8b255c2`) shipped. This spec covers **H6 · Settings & Mediation** — the FINAL slice, completing the web→mobile HomeChef parity effort.

## Goal

Port HomeChef's four remaining admin areas to mobile at full parity: **Platform Settings** (editable platform policy / subscription pricing / referral config), **Staff** (list + invitations + activate/deactivate), **Audit Log** (read-only filtered trail), and **Mediation** (message inbox + relay + block). After this slice, only the DevAI area (1 trivial screen, separate) remains; the HomeChef hub has no `live:false` rows left.

## Scope

Four screens + hub wiring. All on the `hc` gateway (`/api/admin/apps/homechef/gw`). No `plat` client needed.

1. **Platform Settings** — `apps/mobile/app/homechef/platform-settings.tsx` (hc; M — editable, money-sensitive). NEW hub row.
2. **Staff** — `apps/mobile/app/homechef/staff.tsx` (hc; M — authoring). Flips the EXISTING `live:false` Staff row.
3. **Audit Log** — `apps/mobile/app/homechef/audit-log.tsx` (hc; S — read-only). NEW hub row.
4. **Mediation** — `apps/mobile/app/homechef/mediation.tsx` (hc; S/M — trust-sensitive). NEW hub row.

Hub wiring (`app/homechef/index.tsx`): a new **"Settings & mediation"** group with Platform Settings + Audit Log + Mediation rows (all `live:true`), and flip the existing **Staff** row (currently in the "People & quality" group, `live:false`) to `live:true`.

## Decisions (resolved during brainstorming)

- **All four areas in one slice** (one spec → plan → SDD cycle) — the final parity push.
- **Platform Settings: full parity, editable + confirm** (user's call). The 3 config forms re-price the platform live on save, so each save is confirm-gated (reuse the H1 `useConfirm` PromptSheet). Numeric fields string-held, `Number()`-converted on submit (established pattern). Money-sensitive → extra SDD review weight.
- **Mediation: full parity — inbox + relay + block** (user's call). Relay forwards customer PII irreversibly; block is silent. BOTH actions are confirm-gated (destructive tone). Trust-sensitive → extra SDD review weight.
- **Staff type fix: mobile-local correct type** (user's call). The shared `StaffMember` contract is mis-shaped (nested `user` vs the actual flat wire); the web page already works around it with a page-local type. Mobile declares the correct flat shape locally (next to the staff hooks in `lib/hooks.ts`) and stops using the shared `StaffMember` for the staff list. Contained to this slice — no change to `@tesserix/homechef-shared`, zero risk to web or other services.
- **Audit Log: read-only.** It returns a FLAT `{ logs, total, page, limit }` envelope (NOT the usual `Paginated<T>`) — the hook and screen handle that shape explicitly rather than forcing it into `Paginated<T>`.

## Screens

### 1. Platform Settings (`platform-settings.tsx`) — hc, editable, money-sensitive

**Reads:** `GET /platform/policy` → `PlatformPolicy`; `GET /subscription-pricing` → `SubscriptionPricing`; `GET /referral/config` → `ReferralConfig`.
**Actions:** `PUT /platform/policy` (full `PlatformPolicy`); `PUT /subscription-pricing` (full `SubscriptionPricing`); `PUT /referral/config` (full `ReferralConfig`). Each PUT sends the COMPLETE typed object (no partial-PUT wipe — same discipline as the winback/loyalty saves), confirm-gated.

**UI:** three stacked config cards (one per resource), each: load current values → editable fields (numeric string-held → `Number()` on save; booleans as `Switch`; any enum/day-set as appropriate controls) → Save button → confirm dialog (message states the change re-prices/affects the platform live) → saved/error state (`Banner` + `Alert` on failure). Each card saves independently and invalidates its own query. Money is rupees where applicable (raw numbers via `formatINR`, no ÷100). **Gotcha:** `operatingDays: []` (if present in `PlatformPolicy`) means "open EVERY day", not "closed" — the extraction pins the exact meaning and the editor must not silently coerce empty → closed.

**Exact field lists** for `PlatformPolicy` / `SubscriptionPricing` / `ReferralConfig` come from the extraction step (they drive the three forms).

### 2. Staff (`staff.tsx`) — hc, authoring

**Reads:** `GET /staff` → staff list (flat wire shape — mobile-local type, NOT the shared `StaffMember`); `GET /staff/invitations` → pending invitations.
**Actions:** `POST /staff/invitations` (invite — email + role, from a small form/prompt); `PUT /staff/invitations/:id/revoke`; `PUT /staff/invitations/:id/resend`; `PUT /staff/:id/activate`; `PUT /staff/:id/deactivate`.

**UI:** a staff-member list (name/email/role + active badge, with activate/deactivate action gated on current state) and a pending-invitations list (email/role + revoke/resend actions). An "Invite staff" affordance (form or `useConfirm().prompt`-style entry capturing email + role). Deactivate uses a confirm. Not money-sensitive. Mobile-local flat staff type declared beside the hooks; `useStaff` is corrected to that type (its current shared-`StaffMember` import is the bug being fixed).

### 3. Audit Log (`audit-log.tsx`) — hc, read-only

**Reads:** `GET /audit-logs` with filter query params → FLAT `{ logs: AuditLogEntry[]; total: number; page: number; limit: number }` (NOT `Paginated<T>`).
**UI:** a filtered, paginated read-only list — each entry shows actor / action / target / timestamp (+ tap-to-expand metadata if the entry carries a detail blob, mirroring the Mark8ly audit screen pattern). Filter chips for whatever dimensions the endpoint supports (extraction pins the exact filter params + entry shape). Prev/next pagination off `total`/`page`/`limit`. No mutations.

### 4. Mediation (`mediation.tsx`) — hc, trust-sensitive

**Reads:** `GET /messages/inbox` → mediated-message inbox (local `MediatedMessage` type — extraction pins the shape).
**Actions:** `POST /messages/:id/relay` (forwards the message/PII — irreversible); `POST /messages/:id/block` (silently blocks — effectively irreversible). BOTH behind a destructive `useConfirm` with copy that states the consequence (relay: "forwards the customer's details, can't be undone"; block: "silently blocks this sender").
**UI:** an inbox list (sender/recipient/preview/flagged-reason + state) with per-message Relay and Block actions. Confirm-gated, `Alert` on failure, invalidates the inbox on success. No forms.

## Data-layer summary

**`lib/hooks.ts` (hc):** new `qk` keys + hooks —
- Settings: `usePlatformPolicy`/`useSavePlatformPolicy`, `useSubscriptionPricing`/`useSaveSubscriptionPricing`, `useReferralConfig`/`useSaveReferralConfig` (each save PUTs the full typed object, invalidates its own key).
- Staff: `useStaff` (corrected to a mobile-local flat `StaffRow` type), `useStaffInvitations`, `useInviteStaff`, `useRevokeInvitation`/`useResendInvitation`, `useSetStaffActive` (activate/deactivate).
- Audit: `useAuditLogs(filters)` returning the flat `{logs,total,page,limit}` shape + a local `AuditLogEntry` type (if not shared).
- Mediation: `useMediationInbox`, `useRelayMessage`, `useBlockMessage` + a local `MediatedMessage` type.

**Exact wire shapes** (`PlatformPolicy`/`SubscriptionPricing`/`ReferralConfig` field lists incl. money/day-set semantics; the flat staff wire shape + invitation shape; audit filter params + `AuditLogEntry`; `MediatedMessage`) — a general-purpose extraction agent pulls these verbatim from `@tesserix/homechef-shared` and the four web pages BEFORE the plan. Critical given the settings-form density and the two shape surprises (flat staff, flat audit envelope).

## Testing & gate

No RN unit-test runner. Gate = `pnpm --filter @tesserix/homechef-shared build` then `cd apps/mobile && npx tsc --noEmit`, clean (0 errors). Multi-stage SDD review — the Platform Settings saves (live re-pricing) and the Mediation relay/block (irreversible, PII) warrant extra care. Device smoke = user's step (needs their real Google login on the sim).

## Execution

Established cycle: this spec → **extraction agent** (essential — the settings forms need exact field lists; two wire shapes deviate from convention) → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (fresh haiku implementer per task + sonnet task reviewer + final opus whole-branch review; ledger at `.superpowers/sdd/progress.md`). Commit directly to `main`, single-line messages, no signatures. Confirm with the user before pushing (push rebuilds/redeploys the prod company image).

### Suggested task order (for the plan)
1. hc hooks — Platform Settings (3× config/save) + local money/day semantics.
2. hc hooks — Staff (list w/ local flat type, invitations, invite/revoke/resend/activate/deactivate) + Audit (flat-envelope list) + Mediation (inbox/relay/block) + local types.
3. Platform Settings screen (3 editable config cards + confirm-gated saves).
4. Staff screen (list + invitations + actions + invite affordance).
5. Audit Log screen (filtered read-only list + pagination).
6. Mediation screen (inbox + confirm-gated relay/block).
7. Hub wiring (new "Settings & mediation" group + flip Staff row) + full gate.
