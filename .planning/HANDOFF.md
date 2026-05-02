# Handoff — Tesserix super-admin tool

**Last session:** 2026-05-02 — small ops sweep (E5/O3/E3) + Phase 3 B1 + B1f. Templates registry covers mark8ly platform-api (4 templates) AND marketplace-api orderdoc (4 templates) + giftcard (1 template). 9 templates total now operator-editable via tesserix-home. Latest commits: `87371ea` tesserix-home, `bc5bc14` mark8ly.
**Branch:** main (no PRs in flight; commits go directly to main per workflow_preferences memory)

This file is the entry point for the next session. Read it first.

---

## What's live in production

Tesserix super-admin app at `https://tesserix.app/admin/*`. Deployed via ArgoCD as `company` deployment in the `tesserix` namespace. CI builds image per commit (`main-<sha>`), CronJob runs synthetic uptime probes every 5 min.

**Image pin pattern:** the company chart's `image.tag` helm parameter (in `tesserix-k8s/argocd/prod/apps/global/company.yaml`) is bumped on each release. ArgoCD `RespectIgnoreDifferences=true` keeps live state stable. Current pin: `main-cc4d61d` (next bump should pick up `main-d15b192` which contains E5 / O3 / E3).

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
| **Email templates** | `/admin/notifications/templates` | B1 — list + edit + preview + test-send; cross-DB writes to mark8ly's email_templates |

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

## Recently shipped (2026-05-02)

### ✅ Phase 3 B1f — Email templates registry extended to marketplace-api (orderdoc + giftcard)
- **Shared loader package** (commit `e5d4a4c`): `services/marketplace-api/internal/emailtemplates/` — same shape as platform-api's `notification/db_loader.go` but in its own package because orderdoc + giftcard + future packages share it. Public Register / Render / Invalidate / SeedFromEmbedded surface. Includes `SendGridTestSender` for the test-send endpoint.
- **orderdoc refactor** (commit `2c62167`): subjects lifted from `fmt.Sprintf` switch into Go-template strings stored in DB (with `{{if .IsFullRefund}}…{{else}}…{{end}}` for state-driven dynamic subjects). Heading / Lede / CTAButtonLabel stay computed in Go (business-logic-driven). 4 templates: `orderdoc_invoice_email`, `orderdoc_receipt_email`, `orderdoc_cancellation_email`, `orderdoc_refund_email`.
- **giftcard refactor** (commit `bc5bc14`): same pattern. 1 template: `giftcard_delivery`. Subject template `"You received a gift card from {{.Theme.StoreName}}"`.
- **Internal endpoints in marketplace-api**: `POST /internal/templates/refresh` + `POST /internal/templates/:key/test` (mounted alongside existing /internal routes; same network policy posture as platform-api).
- **Tests**: 16 emailtemplates + 6 orderdoc + 5 giftcard = 27 new tests. Includes byte-identity proof tests (DB-rendered = embedded-rendered for the same vars) — the safety net that catches drift between seed migration and embedded fallback.
- **Out of scope**:
  - **campaign envelope** — subject is per-campaign data set by `send_worker`, not a static template string. Different shape entirely from the registry pattern. Operator can edit campaign body content via the campaign editor flow, not via the templates registry. Documented as out-of-scope.
  - **Inline-string mailers** (otto OTP, marketplace-api shipping label envelope, dunning placeholders) — would need a small refactor to extract into file-based templates first; queued for a follow-up if/when operator-edit need surfaces.

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

### A. Phase 1 Wave 1.5 — `notification-service` email_events ingestion 🔒 BLOCKED

**Blocked on:** SendGrid Event Webhook signing key configured in SendGrid console + stored in GSM as `notification-service-sendgrid-webhook-secret`.

Once unblocked (highest immediate value — closes the loop on email metrics):
- Add migration in `../notification-service/migrations` for `email_events` table (schema in `.planning/phases/01-resources-cost-dashboards/PLAN.md` Wave 1.5)
- Add `POST /webhooks/sendgrid` receiver with HMAC verify
- Add `GET /internal/email-events/aggregate` for tesserix-home to query
- Update tesserix-home `lib/metrics/email-events.ts` to call notification-service instead of returning zeros
- Wave 5 `custom_args` are already in flight at the send sites — engagement events will carry tenant_id from day 1 of webhook receiver

### B. Phase 3 — Templates Registry + Lead Marketing Send

**Architecture pivot (2026-05-02):** dropped notification-service entirely (it's dormant — no helm chart, no consumers, mark8ly explicitly bypassed it). Templates now live per-product in each product's own DB; tesserix-home is the authoring surface and writes via the existing cross-DB grant. Admin UI calls a tiny `/internal/templates/refresh` endpoint to evict cache; falls back to embedded if DB row is missing.

- ✅ **B1 (platform-api half)** — DONE. Migration + loader + caller updates + refresh endpoint + admin UI shipped.
- ✅ **B1f (marketplace-api orderdoc + giftcard)** — DONE. Shared loader package + 5 templates lifted (4 orderdoc kinds + 1 giftcard delivery). Campaign envelope deliberately skipped (per-campaign data, doesn't fit registry shape).
- ⏳ **B1f follow-up (inline-string mailers)** — out of scope: otto OTP, marketplace-api shipping label envelope, dunning/payment_action_reminder placeholders. Each needs a small refactor to extract inline strings into file-based templates before they can join the registry. Defer until operator-edit need surfaces.
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

**Default — Phase 3 templates (per user direction 2026-05-02):**

"Read `.planning/HANDOFF.md`. Small-ops sweep is done (E5/O3/E3 shipped). Pick up Phase 3 — Templates Registry (B1): extend `../notification-service.templates` with `product_id`+`kind`+`key` columns and seed 10 mark8ly templates. Build a read-only admin UI under `/admin/notifications/templates` that lists the catalog. After B1 lands, B2 (lead invite/marketing send) wires the Mark8ly leads page through to notification-service. B3 (rewire transactional sends) stays deferred — high risk."

**If the SendGrid signing key has shown up:**

"Read `.planning/HANDOFF.md`. The SendGrid Event Webhook signing key is in GSM as `notification-service-sendgrid-webhook-secret`. Pivot to Phase 1 Wave 1.5 (highest-value when unblocked): add the `email_events` migration in `../notification-service/migrations`, the `POST /webhooks/sendgrid` receiver with HMAC verify, and the `GET /internal/email-events/aggregate` endpoint. Then update `tesserix-home/lib/metrics/email-events.ts` to call notification-service instead of returning zeros."
