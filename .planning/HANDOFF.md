# Handoff — Tesserix super-admin tool

**Last session:** 2026-05-02 — F4 + F1 wave 3 shipped through commit `cc4d61d` (tesserix-home), `4103fe74` (tesserix-k8s)
**Branch:** main (no PRs in flight; commits go directly to main per workflow_preferences memory)

This file is the entry point for the next session. Read it first.

---

## What's live in production

Tesserix super-admin app at `https://tesserix.app/admin/*`. Deployed via ArgoCD as `company` deployment in the `tesserix` namespace. CI builds image per commit (`main-<sha>`), CronJob runs synthetic uptime probes every 5 min.

**Image pin pattern:** the company chart's `image.tag` helm parameter (in `tesserix-k8s/argocd/prod/apps/global/company.yaml`) is bumped on each release. ArgoCD `RespectIgnoreDifferences=true` keeps live state stable. Current pin: `main-cc4d61d`.

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
| **Break-glass audit** | `/admin/break-glass` | F4 — rotation SLA + recently-used flag |

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

Plan written but not started. Lower priority while leads pipeline is empty.
- B1 — Templates Registry (read-only canon): extend `notification-service.templates` with `product_id`+`kind`+`key`; seed 10 mark8ly templates
- B2 — Lead invite/marketing send: Mark8ly Leads page → marketing template → notification-service
- B3 (later) — Rewire mark8ly transactional sends to fetch from registry. **High risk** — touches live billing/email paths.

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

See `BACKLOG.md` for full list. Notable ones:
- E2 — Notification log (depends on D unblocking SendGrid ingestion)
- E3 — Service health snapshot via Prometheus proxy
- M2 — Custom-domain DNS verification dashboard
- O3 — Global Cmd+K command palette
- O7 — Failed login / auth-anomaly tracker (FR — needs a source table inventoried first)

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
- ⏳ **SendGrid Event Webhook signing key** in GSM as `notification-service-sendgrid-webhook-secret` (Phase 1 Wave 1.5 — the only remaining external dependency unblocking email engagement metrics)
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

**If the SendGrid signing key is now available:**

"Read `.planning/HANDOFF.md`. The SendGrid Event Webhook signing key is now in GSM as `notification-service-sendgrid-webhook-secret`. Pick up Phase 1 Wave 1.5 — add the `email_events` migration in `../notification-service/migrations`, the `POST /webhooks/sendgrid` receiver with HMAC verify, and the `GET /internal/email-events/aggregate` endpoint. Then update `tesserix-home/lib/metrics/email-events.ts` to call notification-service instead of returning zeros. Wave 5 `custom_args` are already in flight at the send sites."

**If the signing key is still pending:**

"Read `.planning/HANDOFF.md`. Phase 1 Wave 1.5 is still blocked on the SendGrid signing key. Pick up Phase 3 — Templates Registry (B1) — extend `notification-service.templates` with `product_id`+`kind`+`key` and seed 10 mark8ly templates. Read-only canon for now; rewire of mark8ly transactional sends (B3) deferred until B1+B2 are validated."

**If you want a smaller win:**

"Read `.planning/HANDOFF.md`. Take a sweep through the small backlog items I've left flagged: E3 (Service health snapshot via Prometheus proxy), M2 (Custom-domain DNS verification dashboard), or O3 (global Cmd+K palette). Pick whichever needs fewer external dependencies."
