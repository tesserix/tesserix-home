# Handoff — Tesserix super-admin tool

**Last session:** 2026-05-02 — small ops sweep (E5/O3/E3) + Phase 3 B1 + B1f + Wave 1.5 + B2 + shipment_dispatched. Templates registry covers **10** customer-facing product templates (platform-api 4 + marketplace-api orderdoc 5 + giftcard 1). B2 lead invite + marketing send is live: tesserix-home owns lead templates, sends directly to SendGrid, write-logs every send to `platform_outbound_emails`. Wave 1.5 webhook receiver is built and waiting for the SendGrid signing key to land in GSM. CI is **green** on main for both repos. Latest commits: `fa28c49` tesserix-home, `435319c` mark8ly.
**Branch:** main (no PRs in flight; commits go directly to main per workflow_preferences memory)

**One-line status of email templates work:** registry infrastructure is complete; 10 file-based customer templates lifted; 3 inline-string templates (otto OTP, dunning placeholders, shipping_label) deferred per `B1F_FOLLOWUP.md`; operator config steps still required for full prod activation (see "Still needed" below).

This file is the entry point for the next session. Read it first.

---

## What's live in production

Tesserix super-admin app at `https://tesserix.app/admin/*`. Deployed via ArgoCD as `company` deployment in the `tesserix` namespace. CI builds image per commit (`main-<sha>`), CronJob runs synthetic uptime probes every 5 min.

**Image pin pattern:** the company chart's `image.tag` helm parameter (in `tesserix-k8s/argocd/prod/apps/global/company.yaml`) is bumped on each release. ArgoCD `RespectIgnoreDifferences=true` keeps live state stable. Current pin: `main-cc4d61d`. **Next bump targets:**
- `tesserix-home` → `main-fa28c49` (E5 + O3 + E3 + B1 admin UI + Wave 1.5 receiver + B2 lead-send + lint fix)
- `mark8ly platform-api` → `main-14c6e33` (B1 templates registry)
- `mark8ly marketplace-api` → `main-435319c` (B1f orderdoc + giftcard + shipment_dispatched + ExpectedSchemaVersion=85)

| Surface | Path | Notes |
|---|---|---|
| Mark8ly overview | `/admin/apps/mark8ly` | CPU/memory/pods/cost/email — email zero until D ships |
| Tenant detail | `/admin/apps/mark8ly/tenants/[id]` | Activity + cost share + margin |
| Subscriptions | `/admin/apps/mark8ly/subscriptions` | Synthesizes trial when no subscription row |
| **Onboarding funnel** | `/admin/apps/mark8ly/onboarding` | E1 — in-flight / abandoned / completed, time-to-complete |
| Audit logs | `/admin/apps/mark8ly/audit-logs` | Mark8ly events |
| Platform tickets list | `/admin/platform-tickets` | Phase 5 |
| Platform ticket detail | `/admin/platform-tickets/[id]` | Phase 5.6 — thread + composer + status stepper |
| Platform announcements | `/admin/platform-announcements` | Composer + list |
| **Cross-product search** | `/admin/search` + header dropdown | F1 W1+W2 — 8 sources, debounced |
| **User profile** | `/admin/users/[email]` | F1 W3 — consolidated identity across 8 sources |
| **GDPR queue** | `/admin/erasure-requests` | F3 — `customer_erasure_requests`, 14d warn / 30d breach |
| **Synthetic uptime** | `/admin/uptime` | M1 — 1h/6h/24h/7d windows, p50/p95, CronJob driven |
| **Service health** | `/admin/health` | E3 — workload pod readiness + restart counts (kube-state-metrics) |
| **Outbox events** | `/admin/outbox` | E5 — stuck/dead rows across mark8ly platform_api + marketplace_api |
| **Break-glass audit** | `/admin/break-glass` | F4 — rotation SLA + recently-used flag |
| **Cmd+K palette** | global keyboard | O3 — admin destinations + cross-product user search, mounted in admin layout |
| **Email templates** | `/admin/apps/mark8ly/notifications/templates` | B1 — list + edit + preview + test-send; cross-DB writes to mark8ly's email_templates (10 templates: platform-api 4 + marketplace-api 6). Relocated from `/admin/notifications/templates` since these are mark8ly-owned, not platform-owned |
| **Lead templates** | `/admin/notifications/lead-templates` | B2 — operator-authored lead/marketing templates in `tesserix_admin.platform_lead_templates`; ships seeded with `lead_welcome`, `lead_demo_invite`, `lead_followup_no_response` once migration `0006` is applied |
| **Notification log** | `/admin/notifications/log` | E2 — engagement event feed from `email_events`; KPIs (sent/delivered/opens/clicks/bounces/unsubs) + recent rows; filters by product / tenant / window. Empty until SendGrid webhook is configured |
| **Send email to lead** | `/admin/apps/mark8ly/leads` (modal) | B2 — picks a published lead template, idempotent send via SendGrid, audit log in `platform_outbound_emails` |
| **SendGrid webhook** | `POST /webhooks/sendgrid` | Wave 1.5 — ECDSA-verified, idempotent on `sg_event_id`, populates `email_events`. Returns 401 in prod until signing key is in GSM |
| **Email events read** | `GET /api/admin/email-events` | Wave 1.5 — `?view=metrics&product=&tenant_id=&days=` (aggregate) OR `?view=recent` (raw event log) |

**Mark8ly admin merchant surfaces (cross-repo, shipped 5.5/5.6):**
- `/(admin)/support/platform` — file platform support ticket
- `/(admin)/support/platform/[id]` — thread + reply composer
- Active platform-announcement banner mounted in `AdminShell`

**Phase 5/5.5/5.6 internal endpoints (bearer-authed via `X-Internal-Token` — NOT `Authorization` because istio-ingress JWT-validates the latter):**
- `POST /api/internal/platform-tickets` — file
- `GET /api/internal/platform-tickets?product=&tenant_id=` — list
- `GET /api/internal/platform-tickets/[id]?product=&tenant_id=` — single + thread
- `POST /api/internal/platform-tickets/[id]/replies` — merchant reply (auto-reopens resolved tickets)
- `GET /api/internal/platform-announcements?product=&tenant_status=` — active announcements
- `POST /api/internal/uptime/probe` — triggers a probe sweep (called by CronJob)

**Phase 5.5 cross-repo work (uncommitted):**
- `tesserix-k8s` — `INTERNAL_API_TOKEN` wired into the `company` chart's ExternalSecret + new ExternalSecret in `mark8ly-admin` chart; both pull GSM key `prod-tesserix-internal-api-token`
- `mark8ly` — new `lib/api/tesserix.ts` client, `app/(admin)/support/platform/page.tsx`, `components/support/PlatformTicketForm.tsx`, sidebar entry "Platform support", new `/api/platform-announcements` proxy route, new `PlatformAnnouncementBanner` mounted in `AdminShell`

**Manual operator step before redeploy:**
1. Create the GSM secret: `gcloud secrets create prod-tesserix-internal-api-token --replication-policy=automatic --data-file=- <<<"$(openssl rand -hex 32)"`
2. Grant access to both Workload Identity SAs (tesserix + mark8ly admin)
3. Sync ArgoCD `company` and `mark8ly-admin` apps after the next image roll

---

## Recently shipped (2026-05-02 PM — UX restructure + E2 + 0006 seed)

### ✅ UX — Email templates moved under Mark8ly section
- Moved `/admin/notifications/templates/*` → `/admin/apps/mark8ly/notifications/templates/*`. The pages are mark8ly-owned data (templates live in mark8ly's own DBs); they belong under the Mark8ly product section, not the Platform notifications namespace. Future products mirror the pattern (`/admin/apps/<product>/notifications/templates`).
- Sidebar: added Notifications group to `mark8lyNav`; removed Email templates from `platformNav`.
- Cmd+K: same entry, regrouped under Mark8ly with new href.
- Improved error message on the templates list — now points the operator at the operator activation checklist when the cross-DB query fails (typical cause: mark8ly platform-api not yet rolled, so migration `0013` hasn't applied).

### ✅ E — `MARK8LY_MARKETPLACE_API_URL` shortfall fixed
- `lib/api/mark8ly-internal.ts` now routes both `refreshTemplateCache` and `sendTestEmail` by database. Marketplace-api templates ping marketplace-api for cache eviction; platform-api templates ping platform-api. Same with test-sends — they go through the right service so the rendered output is byte-identical to what production would send.
- `app/api/admin/email-templates/[key]/test-send/route.ts` reads `?database=` and threads it through. The edit page already passes the param.

### ✅ D — Lead-marketing template seeds (`0006_seed_lead_templates.sql`)
- Three starter templates so `/admin/notifications/lead-templates` ships with content rather than the empty state:
  - `lead_welcome` — first-touch acknowledgement (vars: FirstName, SenderName)
  - `lead_demo_invite` — walkthrough invite with conditional CompanyName + MeetingURL CTA (vars: FirstName, CompanyName, MeetingURL, SenderName)
  - `lead_followup_no_response` — quiet check-in, no urgency (vars: FirstName, SenderName)
- Voice follows mark8ly's editorial brand (calm, premium, refined). HTML uses paper/ink/moss palette inline; Source Serif 4 with Georgia fallback for headlines.
- `ON CONFLICT (key) DO NOTHING` so re-runs don't clobber operator edits.

### ✅ E2 — Notification log UI
- `/admin/notifications/log` reading from `lib/db/email-events.ts` (`aggregateEmailMetrics` + `listRecentEmailEvents`).
- KPIs: Sent / Delivered (with rate %) / Opens (with rate %) / Clicks / Bounces (incl. dropped) / Unsubscribes.
- Filters: product (any | mark8ly), tenant_id, window (24h / 7d / 30d / 90d). Auto-refresh every 30s.
- Recent table: time, event-type pill (color-coded), product, tenant, template_key, recipient, reason. Empty state explains the most likely cause (SendGrid webhook not yet configured).
- Sidebar + Cmd+K entries added (Platform notifications group).

### ✅ Round-trip smoke harness
- `scripts/smoke-templates.sh` — bash + curl, requires SESSION_COOKIE env. Exercises GET → PUT → GET → test-send → restore against the user-facing API. Asserts version bump and subject persistence at each step.
- `.planning/SMOKE-TEMPLATES.md` — operator-side activation checklist + manual UI steps for product templates / marketplace-api templates / engagement ingestion / lead-marketing send. Diagnostic table for common failure modes.

## Recently shipped (2026-05-02)

### ✅ B2 — Lead invite + marketing send
- New tables in tesserix_admin (migration `0005`): `platform_lead_templates` (operator-editable lead/marketing templates) + `platform_outbound_emails` (audit log of every outbound send)
- Admin UI: `/admin/notifications/lead-templates` list + edit (subject/html/text + iframe preview + variables panel + test-send) — same UX shape as product templates but pointed at tesserix DB
- Lead-side flow: "Send email" button on every row of `/admin/apps/mark8ly/leads`; opens a modal with template picker; idempotent send via `POST /api/admin/leads/[id]/send-email`
- SendGrid integration: direct POST to v3 from tesserix-home (no product hop), Wave 5-style `custom_args` carrying `product`, `kind=lead_email`, `template_key`, `lead_id` so engagement events flow back through the same Wave 1.5 webhook
- Local Go-template-flavored renderer (`lib/templates/render.ts`) — supports `{{.Field}}` and `{{if .Field}}…{{else}}…{{end}}`, with HTML auto-escape in html mode and passthrough in text mode
- `last_contacted_at` on the lead row gets bumped on every successful send so the leads list shows engagement freshness

### ✅ Phase 1 Wave 1.5 — SendGrid webhook receiver + email_events
- Migration `0005` (bundled with B2): `email_events` table with indexes for the dashboard query shapes (`product`, `tenant_id`, `event_at`, `template_key`, `lead_id`)
- `POST /webhooks/sendgrid` receiver with ECDSA signature verification (gated by `SENDGRID_WEBHOOK_VERIFY=false` for dev)
- Replay protection: rejects events older than 10 minutes
- Wave 5's instrumented `custom_args` (`product`, `tenant_id`, `kind`, `template_key`, `campaign_id`, `lead_id`) all flow into typed columns at insert time
- ON CONFLICT DO NOTHING on `sg_event_id` makes SendGrid retries idempotent
- Read endpoint: `GET /api/admin/email-events?product=&tenant_id=&days=` (aggregate) or `?view=recent` (raw)
- `lib/metrics/email-events.ts` swapped from zero-stub to real query against the new table — dashboards stop returning zeros the moment the first event lands

**Still blocked on operator step:** SendGrid Event Webhook signing key in GSM as `tesserix-sendgrid-webhook-secret`. Until that lands and `SENDGRID_WEBHOOK_PUBLIC_KEY` is set, the receiver in prod will reject every request as `signature_invalid`. Receiver is fully built and exercised; this is just the missing key.

### ✅ Phase 3 B1f — Email templates registry extended to marketplace-api (orderdoc + giftcard + shipment_dispatched)
- **Shared loader package** (commit `e5d4a4c`): `services/marketplace-api/internal/emailtemplates/` — same shape as platform-api's `notification/db_loader.go` but in its own package because orderdoc + giftcard + future packages share it. Public Register / Render / Invalidate / SeedFromEmbedded surface. Includes `SendGridTestSender` for the test-send endpoint.
- **orderdoc refactor** (commit `2c62167`): subjects lifted from `fmt.Sprintf` switch into Go-template strings stored in DB (with `{{if .IsFullRefund}}…{{else}}…{{end}}` for state-driven dynamic subjects). Heading / Lede / CTAButtonLabel stay computed in Go (business-logic-driven). 4 templates: `orderdoc_invoice_email`, `orderdoc_receipt_email`, `orderdoc_cancellation_email`, `orderdoc_refund_email`.
- **giftcard refactor** (commit `bc5bc14`): same pattern. 1 template: `giftcard_delivery`. Subject template `"You received a gift card from {{.Theme.StoreName}}"`.
- **shipment_dispatched (NEW customer email, commit `435319c`)**: filled the missing gap between invoice (placed) and receipt (delivered). Fires when admin marks a shipment `in_transit` via `PATCH .../shipments/:id/status`. Includes carrier + tracking + ETA. `KindShipmentDispatched` enum value, `Mailer.SendShipmentDispatched` on both LogMailer + SendGridMailer, `orderdoc.Service.SendShipmentDispatched(ctx, orderID, ShipmentInfo)`, `dispatchShipmentDispatchedEmail` helper in shipments.go (detached background context, mirrors dispatchReceiptEmail pattern). Same commit also bumped `ExpectedSchemaVersion` to 85 to fix CI.
- **shipment_dispatched follow-up still open**: the carrier webhook path at `delhivery_webhook.go:300` also stamps `shipped_at` when the carrier reports pickup. Currently does NOT fire the email. Wiring it requires dedup logic against the admin path so a customer doesn't get two "shipped" emails.
- **Internal endpoints in marketplace-api**: `POST /internal/templates/refresh` + `POST /internal/templates/:key/test` (mounted alongside existing /internal routes; same network policy posture as platform-api).
- **Tests**: 16 emailtemplates + 6 orderdoc + 5 giftcard = 27 new tests. Includes byte-identity proof tests (DB-rendered = embedded-rendered for the same vars) — the safety net that catches drift between seed migration and embedded fallback.
- **Out of scope** (see `B1F_FOLLOWUP.md` for full per-service work):
  - **campaign envelope** — subject is per-campaign data set by `send_worker`, not a static template. Different shape; doesn't fit registry. Operator edits campaign content via the campaign editor flow.
  - **shipping_label envelope** — confirmed during session that this is internal/operational (merchant emails labels to themselves/warehouse/3PL — never to the customer). Low value for operator-edit. Marked **skip-by-design**.
  - **otto OTP** — otto is a separate Go service with its own DB. Needs vendor-vs-`go-shared` decision before lifting.
  - **dunning_day_5/7 + payment_action_reminder** — `email/templates.go` is empty (just constants). Blocked on copy/content (likely needs billing/legal review).

### ✅ Phase 3 B1 — Email templates registry (mark8ly platform-api side + tesserix-home authoring UI)
- **mark8ly platform-api** (commit `14c6e33`):
  - Migration `0013_create_email_templates` — runtime-editable templates table (key PK, subject/html/text/vars/status/version columns)
  - `internal/notification/db_loader.go` — DB-first loader with embedded fallback + 5min TTL cache + idempotent SeedFromEmbedded (ON CONFLICT DO NOTHING) called at startup
  - All 4 callers updated to use `loader.Render(ctx, key, ...)` — auth/verification/invitation/onboarding services
  - `internal/notification/handler.go` — `POST /internal/templates/refresh` (cache evict) + `POST /internal/templates/:key/test` (test-send through real SendGrid pipeline)
  - Full unit + handler tests + DB-backed integration tests (byte-identity proof: DB-rendered output equals embedded-rendered output for the seed catalog)
- **tesserix-home** (commit `fb27a5c`):
  - `lib/db/email-templates.ts` — cross-DB CRUD via existing `mark8ly_platform_admin` grant
  - `lib/api/mark8ly-internal.ts` — HTTP client for cache-refresh + test-send
  - `/admin/notifications/templates` list + edit pages with side-by-side editor / iframe preview / sample-vars test-send
  - Sidebar + Cmd+K entries
- **Architecture choice (per user):** templates live in each product's own DB (mark8ly here). Tesserix-home is the authoring surface only. Mark8ly services never touch tesserix DB. Lead/marketing templates (B2) will live in tesserix_admin DB since tesserix owns the lead pipeline.
- **Verification path (no live prod traffic yet):** API trigger end-to-end — call `POST /auth/password-reset` / complete an onboarding session / etc. with operator email → operator receives the new template. Embedded fallback safety net means mis-edits don't break sends.

### ✅ E5 — Outbox events monitor
- `/admin/outbox` — federated read across mark8ly's two outbox tables (platform_api uses status enum; marketplace_api uses `published_at IS NULL`)
- Per-DB cards (pending / in-flight / stuck / dead) + combined recent-stuck table sorted by age
- Stuck threshold: pending > 5 min; auto-refresh every 30s
- Files: `lib/db/outbox-events.ts`, `app/api/admin/outbox/route.ts`, `app/admin/outbox/page.tsx`, sidebar entry

### ✅ O3 — Cmd+K command palette
- Global keyboard launcher (Cmd/Ctrl+K) mounted in `app/admin/layout.tsx` via `CommandPaletteProvider`
- Two intents in one box: admin destinations (filtered by typed query) + cross-product user search (debounced ≥3 chars)
- Email queries surface a "consolidated profile" link to `/admin/users/[email]`
- Discoverable header trigger button shows the keyboard shortcut so users learn the hotkey
- Files: `components/admin/command-palette.tsx`, header trigger added to `components/admin/header.tsx`
- Implementation note: @tesserix/web's `Command` is a custom (non-cmdk) primitive — selection is dispatched via `onValueChange` on the wrapper, not `onSelect` on items. We use a value→handler ref map. CommandInput's internal `query` state drives item filtering, so we mirror via `onInput` (additive) instead of overriding `value`/`onChange`.

### ✅ E3 — Service health snapshot
- `/admin/health` — workload-level pod readiness + restart counts via Prometheus + kube-state-metrics
- KPIs: workloads / healthy / degraded / down / restarts-24h
- Status: healthy / degraded / down / idle (idle = scale-to-zero, not alarming)
- Filters: namespace pills + "hide idle" toggle; auto-refresh every 30s
- Workload name resolution: `serving.knative.dev/service` → `app.kubernetes.io/name` → `app` → pod prefix
- Files: `lib/metrics/service-health.ts`, `app/api/admin/service-health/route.ts`, `app/admin/health/page.tsx`, sidebar + Cmd+K entries

### ✅ Phase 5.5 + 5.6 — Mark8ly merchant UI + reply flow
- Cross-repo (tesserix-home + tesserix-k8s + mark8ly admin) — fully deployed
- Bearer auth uses `X-Internal-Token` (NOT `Authorization`) because istio-ingress JWT-validates `Authorization: Bearer` headers
- DB schema: `submitted_by_user_id` / `author_user_id` are TEXT (migration 0003) — supports Firebase UIDs
- Inline form validation, toast on success, in-place list refresh

### ✅ Phase 1 Wave 5 — SendGrid `custom_args` instrumentation
- Three mark8ly services (platform-api, otto, marketplace-api) — all 6 send sites carry `product=mark8ly` + `tenant_id` + `kind` (and `campaign_id` for campaign sends)
- Metadata-only / additive — no behavior change
- Won't surface in tesserix-home dashboards until D (webhook ingestion) ships

### ✅ Phase 2 — Pricing constants reconciled
- `lib/products/configs.ts` mark8ly prices now match `mark8ly/services/marketplace-api/internal/billing/pricing/catalog.go` (AUD developed-tier monthly): trial=0, starter=29, studio=75, pro=179, marketplace=0 (no Stripe Price)

### ✅ F1 — Cross-product user search (waves 1, 2, 3)
- `lib/db/users-search.ts` — 8 sources via `Promise.allSettled` for graceful degradation
- Header dropdown + `/admin/search` full page + `/admin/users/[email]` consolidated profile
- Sources: tenants (name OR owner_email), customers, leads (email/name/company), mark8ly_users, invitations, platform_tickets, merchant_tickets, onboarding
- Wave 3 strict-matches by exact email; HomeChef extensibility piece is parked

### ✅ E1 — Onboarding funnel
- `/admin/apps/mark8ly/onboarding` — KPIs (in flight / verified % / completion % / abandoned / median-time-to-complete) + filterable session list with stage pips

### ✅ F3 — GDPR erasure queue
- `/admin/erasure-requests` — queue across all mark8ly tenants
- SLA gradient: 14d amber warn / 30d red breach
- Read-only — actual erasure execution happens via mark8ly admin per tenant

### ✅ M1 — Synthetic uptime
- `/admin/uptime` — per-tenant uptime/p50/p95 with 1h/6h/24h/7d windows, "Down now" KPI
- K8s CronJob `company-uptime-probe` runs every 5 min
- Migration `0004_tenant_uptime_probes.sql` applied to tesserix-postgres

### ✅ F4 — Break-glass account audit
- `/admin/break-glass` — rotation SLA (90d stale flag), recently-used flag (last 7d), MFA enrollment %

### ✅ Operational fixes
- tesserix-postgres pool now retries-once on transient connection drops (CNPG failover safety)
- ArgoCD app for `company` has `RespectIgnoreDifferences=true` so selfHeal doesn't revert CI's image pin
- Image tag pinning convention: `image.tag` helm parameter in `tesserix-k8s/argocd/prod/apps/global/company.yaml` is bumped per release

---

## Pending work — pick up in priority order

### A. Phase 1 Wave 1.5 — SendGrid webhook receiver ✅ BUILT, awaiting signing key

Receiver moved to tesserix-home (notification-service is dormant). All code is shipped — see "Recently shipped". Operator just needs to:
1. Configure the SendGrid Event Webhook in the SendGrid console pointing at `https://tesserix.app/webhooks/sendgrid`
2. Copy the SendGrid-provided ECDSA public key into GSM as `tesserix-sendgrid-webhook-secret`
3. Add `SENDGRID_WEBHOOK_PUBLIC_KEY` to the company chart's ExternalSecret (sourced from the GSM key)
4. ArgoCD sync; receiver starts accepting signed events

Until then, the receiver returns 401 in prod. Dev can override with `SENDGRID_WEBHOOK_VERIFY=false`.

### B. Phase 3 — Templates Registry + Lead Marketing Send

**Architecture pivot (2026-05-02):** dropped notification-service entirely (it's dormant — no helm chart, no consumers, mark8ly explicitly bypassed it). Templates now live per-product in each product's own DB; tesserix-home is the authoring surface and writes via the existing cross-DB grant. Admin UI calls a tiny `/internal/templates/refresh` endpoint to evict cache; falls back to embedded if DB row is missing.

- ✅ **B1 (platform-api half)** — DONE. Migration + loader + caller updates + refresh endpoint + admin UI shipped.
- ✅ **B1f (marketplace-api orderdoc + giftcard)** — DONE. Shared loader package + 5 templates lifted (4 orderdoc kinds + 1 giftcard delivery). Campaign envelope deliberately skipped (per-campaign data, doesn't fit registry shape).
- ⏳ **B1f follow-up (inline-string mailers)** — see `.planning/B1F_FOLLOWUP.md` for the per-service scope. Three services pending (otto OTP, marketplace-api shipping label envelope, dunning placeholders). Recommendation: shipping_label first (~2h, no cross-repo concerns), otto second (decide vendor-vs-go-shared upfront), dunning last (blocked on content).
- ⏳ **B2 — Lead invite/marketing send** — tesserix-home → SendGrid direct path. Templates live in `tesserix_admin.platform_lead_templates`. Operator picks lead, picks template, send. Wave 5 custom_args pattern carries product+kind+lead_id for engagement attribution.
- ⏳ **B3** — Drop. Original B3 was "rewire mark8ly transactional sends to fetch from registry" but B1c already does this. Nothing left.

### C. P initiative — Centralized pricing & discounts (parked, multi-phase)

See BACKLOG.md → §P for the full P1–P5 breakdown. Tesserix-home becomes the authoring surface for plan catalogs + promo codes; Stripe stays the billing engine. Three sources of truth that need to converge: `marketplace-api/internal/billing/pricing/catalog.go`, `mark8ly/packages/ui/src/subscription/pricing-data.ts`, `tesserix-home/lib/products/configs.ts`. P2/P3a are HIGH risk — staged rollout required.

### D. F1 Wave 3 extensibility (parked per user instruction)

`ProductConfig.userSearchSources` array so adding HomeChef tomorrow is config-only. Parked at user request. The detail-page surface (`/admin/users/[email]`) ships without it.

### E. Backlog items skipped this batch (source data missing)

- **F5 — API key inventory**: `api_keys` table doesn't exist in either mark8ly DB. Not shippable until the table is created.
- **N3 — Usage caps & overage**: neither `plan_caps` nor `subscription_usage` tables exist. Would require defining cap rules from scratch first (M-L effort).

### F. Backlog items deferred (large effort)

- **O1 — New product onboarding wizard**: K8s namespace + CNPG cluster + OpenFGA store + secret/grant scaffold UI. 2-3 day wave.
- **F2 — Tenant "view as" (read-only impersonation)**: needs new auth path + careful audit trail. High risk, large effort.

### G. Other small backlog items

See `BACKLOG.md` for full list. Notable ones still pending:
- E2 — Notification log (depends on D unblocking SendGrid ingestion)
- M2 — Custom-domain DNS verification dashboard
- O7 — Failed login / auth-anomaly tracker (FR — needs a source table inventoried first)
- E4 — CNPG cluster health per product (replication lag, WAL, connections) — small, leverages Prom client we've already wired
- O2 — Database backup health dashboard (CNPG ScheduledBackup status) — small, also Prom-based

---

## Operational state — secrets, grants, env vars

### Already provisioned
- ✅ `mark8ly-platform-admin` secret in `tesserix` namespace (cross-DB password)
- ✅ `tesserix-postgres-tesserix-admin` secret (tesserix-postgres `tesserix_admin` role password)
- ✅ `prod-tesserix-internal-api-token` GSM secret + WIF binding to `app-secrets-ext-secrets-prod` SA (used by Phase 5.5 internal endpoints + uptime probe cron)
- ✅ Cross-DB grants on mark8ly billing/tickets/audit/tenant tables (per-table list in earlier HANDOFF revisions)
- ✅ Cross-DB grants extended to: `customer_profiles`, `user_profiles`, `tickets`, `customer_erasure_requests`, `break_glass_accounts`, `onboarding_sessions`, `invitations`
- ✅ NetworkPolicy: company → opencost egress
- ✅ tesserix-home env vars: `PROMETHEUS_URL`, `OPENCOST_URL`, `MARK8LY_DB_*`, `TESSERIX_DB_*`, `INTERNAL_API_TOKEN`
- ✅ Migrations applied to tesserix-postgres: `0002_platform_comms.sql`, `0003_platform_user_id_text.sql`, `0004_tenant_uptime_probes.sql`
- ✅ `company-uptime-probe` CronJob in `tesserix` namespace (every 5 min, drives `/api/internal/uptime/probe`)

### Still needed
- ⏳ **SendGrid Event Webhook signing key** in GSM as `tesserix-sendgrid-webhook-secret` (Phase 1 Wave 1.5 — the only remaining external dependency unblocking email engagement metrics; renamed since the receiver moved out of the dormant notification-service into tesserix-home)
- ⏳ **MARK8LY_PLATFORM_API_URL env var** for tesserix-home in prod — defaults to `http://platform-api.mark8ly.svc.cluster.local` which works in-cluster. Ensure ExternalSecret / values.yaml override picks this up if a different URL is needed.
- ⏳ **NetworkPolicy / AuthorizationPolicy** for tesserix → mark8ly platform-api egress on the /internal endpoints (templates/refresh, templates/:key/test). Verify before relying on the cache-refresh ping in prod.
- ⏳ Optional optimization: switch mark8ly admin → tesserix-home calls from public URL to in-cluster URL. Requires adding `mark8ly` to the company AuthorizationPolicy `allow-ingress-to-tesserix` allowed sources, then flipping `tesserixInternal.url` to `http://company.tesserix.svc.cluster.local`. Saves Cloudflare egress; current public path works.

### Verification commands
```bash
# Confirm last commit on main
git log -1 --oneline

# Confirm pods healthy
kubectl get pods -n tesserix -l app.kubernetes.io/name=company

# Confirm migration applied
PASS=$(kubectl get secret -n tesserix tesserix-postgres-tesserix-admin -o jsonpath='{.data.password}' | base64 -d)
kubectl exec -n tesserix pod/tesserix-postgres-1 -c postgres -- env PGPASSWORD="$PASS" \
  psql -h localhost -U tesserix_admin -d tesserix_admin -c "\dt" | grep platform_

# Smoke-test internal endpoint (will fail with 401 since INTERNAL_API_TOKEN isn't set yet)
POD=$(kubectl get pod -n tesserix -l app.kubernetes.io/name=company -o name | head -1)
kubectl exec -n tesserix $POD -- wget -qO- --header="Authorization: Bearer test" \
  "http://localhost:3000/api/internal/platform-tickets?product=mark8ly&tenant_id=00000000-0000-0000-0000-000000000000"
```

---

## Key conventions established this project

- **Federated read pattern (FR):** Cross-DB SELECT via product-specific roles (`mark8ly_platform_admin`). Documented in `tesserix-k8s/docs/cross-db-admin.md`.
- **Federated write (FW):** Call product API (e.g. mark8ly's `POST /tickets/:id/replies`); we don't write to product DBs directly. Phase 5/6 platform-tickets reply flow uses this.
- **Shared registry (SR):** Platform-owned data products consume (Templates registry future, Platform Announcements present).
- **`ProductConfig`-driven layouts:** Adding HomeChef tomorrow is a config-only change in `lib/products/configs.ts`. No layout code touches "mark8ly" by name.
- **Per-section graceful degradation:** Aggregators use `Promise.allSettled` so one failed upstream doesn't 500 the whole route.
- **60s in-memory TTL cache** in metric clients (Prometheus, OpenCost).
- **Cost-honesty pattern:** "Estimated" baked into section heading + attribution breakdown inline + info-icon tooltip with methodology. Reused for both Phase 1 cost-share and Phase 2 margin.
- **Scoped error boundary** at `app/admin/error.tsx` keeps sidebar visible on page errors.
- **No `Co-Authored-By` or AI attribution in commits** (per project CLAUDE.md and global preferences).
- **Direct commits to main** (per `workflow_preferences` memory) — no feature branches for routine work.

---

## Where to look — file map

| Concern | Path |
|---|---|
| Phase plans + summaries | `.planning/phases/0[1-5]-*/` |
| Backlog / phase ordering | `BACKLOG.md` |
| Cross-DB query helpers | `lib/db/{mark8ly,tesserix,mark8ly-billing,mark8ly-audit,mark8ly-tenant-metrics,mark8ly-onboarding,platform-tickets,platform-announcements,users-search,erasure-requests,break-glass,uptime-probes}.ts` |
| Uptime probe runner | `lib/uptime/runner.ts` |
| Metric aggregators | `lib/metrics/{prometheus,opencost,product-metrics,tenant-metrics,cost-proxy,revenue,margin,trial-likelihood,email-events,window}.ts` |
| ProductConfig | `lib/products/{types,configs}.ts` |
| Admin SWR hooks | `lib/admin/{use-metrics,use-billing,use-audit}.ts` |
| Admin pages | `app/admin/**/*.tsx` |
| API routes | `app/api/admin/**`, `app/api/internal/**` |
| UI primitives | `components/admin/{metrics,billing,audit,tickets/...}/*.tsx` |
| Layouts | `components/admin/{product-overview,tenant-detail,subscriptions-page,audit-logs-page}-layout.tsx` |
| Sidebar | `components/admin/sidebar.tsx` |
| DB migrations | `db/migrations/000[1-4]_*.sql` |
| Sibling repo pointers | `../mark8ly/`, `../tesserix-k8s/`, `../notification-service/` |

---

## Suggested next-session opener

**TL;DR for next session:** Email templates work is essentially done — registry infrastructure is shipped, 10 customer-facing templates lifted, lead-marketing send live, Wave 1.5 webhook receiver built. CI is green on main for both repos. What's left is operator config (image rolls, SendGrid signing key, env vars) plus three deferred templates documented in `.planning/B1F_FOLLOWUP.md` (otto OTP, dunning, shipping_label-skip-by-design).

**Pick one of these prompts depending on what's unblocked:**

**A. If operator config has been done (image rolled + SendGrid key in GSM):**

"Read `.planning/HANDOFF.md`. Email templates infrastructure is live in prod. Validate the round-trip end-to-end: edit a mark8ly welcome template at `/admin/notifications/templates/welcome`, save, then API-trigger by completing an onboarding session with my email. Then start E2 — notification log UI at `/admin/notifications/log` reading from `lib/db/email-events.ts:listRecentEmailEvents` (~1h, data layer already exists)."

**B. If operator config is still pending and you want forward engineering progress:**

"Read `.planning/HANDOFF.md` and `.planning/B1F_FOLLOWUP.md`. Pick up the otto OTP migration to the templates registry. Make the vendor-vs-go-shared decision first (the doc has the tradeoffs). Otto's OTP email is the last customer-facing transactional template not yet operator-editable."

**C. If you want to do small operational items rather than templates work:**

"Read `.planning/HANDOFF.md`. Templates work is done. Pick up E2 (notification log UI — ~1h, data layer ready) OR E4 (CNPG cluster health via Prometheus — small, leverages existing prom client) OR M2 (custom-domain DNS verification dashboard — M effort)."

**D. If you want to seed lead-marketing templates so B2 isn't shipping empty:**

"Read `.planning/HANDOFF.md`. B2 lead-templates surface ships empty. Author the first lead-marketing templates: lead_welcome (intro to mark8ly), lead_demo_invite, lead_followup_no_response. Use the `/admin/notifications/lead-templates/<key>` editor (it'll auto-create a new row when saved). Then validate the leads-page send-email modal end-to-end."

---

## How email templates work end-to-end (for the next session)

Quick mental model so you don't re-discover this:

1. **Product transactional templates** (welcome, invitation, invoice, refund, etc) live in **each product service's own DB** (`mark8ly_platform_api.email_templates` for platform-api, `mark8ly_marketplace_api.email_templates` for marketplace-api). The product service reads them on every send via a per-process loader with 5-min TTL cache. **Embedded fallback** ships in the binary so DB-down ≠ emails-broken.

2. **Tesserix-home is the AUTHORING surface.** It writes to mark8ly's DBs via the existing `mark8ly_platform_admin` cross-DB grant (no FW HTTP hop for the write). After save it pings mark8ly's `POST /internal/templates/refresh` to evict the cache so changes go live in seconds rather than minutes.

3. **Lead/marketing templates** live in `tesserix_admin.platform_lead_templates`. Tesserix-home authors AND sends them directly via SendGrid (no product hop). Audit log in `platform_outbound_emails`.

4. **Engagement attribution** — every send carries Wave 5 `custom_args` (`product`, `tenant_id`, `kind`, `template_key`, optionally `lead_id`/`campaign_id`). SendGrid echoes them back on every event (delivered/open/click/bounce). Wave 1.5 receiver at `/webhooks/sendgrid` ingests them into `tesserix_admin.email_events`. `getEmailMetrics` reads from there.

5. **Test-send button** in the admin UI for a product template POSTs to mark8ly's `/internal/templates/:key/test` — mark8ly renders + sends via its OWN SendGrid client, so the test is byte-identical to a production send. For lead templates it's a direct SendGrid POST from tesserix-home.

## Operator activation checklist (run-once, then templates are fully live)

In rough order:

1. ☐ Bump image pins in `tesserix-k8s/argocd/prod/apps/global/company.yaml`:
   - tesserix-home → `main-fa28c49` (or later)
   - mark8ly platform-api → `main-14c6e33` (or later)
   - mark8ly marketplace-api → `main-435319c` (or later)
2. ☐ Apply migrations to the relevant Postgres clusters (manual `kubectl exec ... psql -f`):
   - tesserix-home migration `0005` (email_events + platform_lead_templates + platform_outbound_emails)
   - tesserix-home migration `0006` (3 starter lead-marketing templates) ← new
   - platform-api migration `0013` (email_templates)
   - marketplace-api migration `000085` (email_templates)
3. ☐ Add `MARK8LY_PLATFORM_API_URL` env to tesserix-home company chart. Default `http://platform-api.mark8ly.svc.cluster.local` should work in-cluster.
4. ☐ Add `MARK8LY_MARKETPLACE_API_URL` env to tesserix-home company chart for marketplace-api templates refresh ping (`http://marketplace-api.mark8ly.svc.cluster.local`). Code is now wired (was hardcoded to platform-api before this session).
5. ☐ Verify NetworkPolicy / AuthorizationPolicy allows tesserix → mark8ly platform-api + marketplace-api egress on `/internal/templates/*`.
6. ☐ Configure SendGrid Event Webhook in console pointing at `https://tesserix.app/webhooks/sendgrid`. SendGrid will give you an ECDSA public key.
7. ☐ Store ECDSA public key in GSM as `tesserix-sendgrid-webhook-secret`.
8. ☐ Add `SENDGRID_WEBHOOK_PUBLIC_KEY` env to company chart's ExternalSecret (sourced from the GSM key above).
9. ☐ ArgoCD sync. Hit the receiver with `gh api repos/.../send-test-event` or trigger a real send to validate.
10. ☐ (Optional) Author first lead-marketing templates so the `/admin/notifications/lead-templates` surface isn't empty.

After all that:
- All 10 product templates editable end-to-end (edit → save → test-send → API-trigger validation in <1 min)
- Engagement events flowing into `email_events`
- Dashboards (Mark8ly Overview, Tenant Detail) showing real email metrics
- Operator can send lead emails via the leads page

## Known shortfall — `MARK8LY_MARKETPLACE_API_URL` ✅ FIXED

The `lib/api/mark8ly-internal.ts` HTTP client now routes by database: platform_api templates ping platform-api, marketplace_api templates ping marketplace-api. Both `refreshTemplateCache` and `sendTestEmail` accept a `database` argument; the test-send API route reads `?database=` from the query string. New env: `MARK8LY_MARKETPLACE_API_URL` (defaults to `http://marketplace-api.mark8ly.svc.cluster.local`).
