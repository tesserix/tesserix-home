# Handoff — Tesserix super-admin tool

**Last session:** 2026-05-01 — Phase 5.5 mark8ly merchant UI + internal announcements endpoint shipped (uncommitted)
**Branch:** main (no PRs in flight; commits go directly to main per workflow_preferences memory)

This file is the entry point for the next session. Read it first.

---

## What's live in production

Tesserix super-admin app at `https://tesserix.app/admin/*`. Deployed via ArgoCD as `company` deployment in the `tesserix` namespace. CI auto-builds on push to main; ArgoCD auto-syncs.

| Phase | Surface | Live? | Notes |
|---|---|---|---|
| 1 | `/admin/apps/mark8ly` overview (CPU/memory/pods/cost/email) | ✅ | Email zero until Phase 1 Wave 1.5 |
| 1 | `/admin/apps/mark8ly/tenants/[id]` (activity + cost share) | ✅ | DB grants applied; row counts populate |
| 2 | `/admin/apps/mark8ly/subscriptions` | ✅ | Synthesizes trial for tenants with no subscription row |
| 2 | Tenant detail Subscription + Margin sections | ✅ | Currency from `stores.currency_code` |
| 4 | `/admin/apps/mark8ly/audit-logs` | ✅ | 13 mark8ly events visible |
| 5 | `/admin/platform-tickets` (super-admin list) | ✅ | Empty until 5.5 ships merchant filing UI |
| 5 | `/admin/platform-announcements` (super-admin composer + list) | ✅ | Functional — try creating one |

**Phase 5 internal endpoints (added in `0df851b`):**
- `POST /api/internal/platform-tickets` — bearer-token authed; mark8ly admin will call this to file
- `GET /api/internal/platform-tickets?product=&tenant_id=` — list a tenant's own tickets

**Phase 5.5 internal endpoints (added this session, uncommitted):**
- `GET /api/internal/platform-announcements?product=&tenant_status=` — bearer-authed; returns active announcements

**Phase 5.5 cross-repo work (uncommitted):**
- `tesserix-k8s` — `INTERNAL_API_TOKEN` wired into the `company` chart's ExternalSecret + new ExternalSecret in `mark8ly-admin` chart; both pull GSM key `prod-tesserix-internal-api-token`
- `mark8ly` — new `lib/api/tesserix.ts` client, `app/(admin)/support/platform/page.tsx`, `components/support/PlatformTicketForm.tsx`, sidebar entry "Platform support", new `/api/platform-announcements` proxy route, new `PlatformAnnouncementBanner` mounted in `AdminShell`

**Manual operator step before redeploy:**
1. Create the GSM secret: `gcloud secrets create prod-tesserix-internal-api-token --replication-policy=automatic --data-file=- <<<"$(openssl rand -hex 32)"`
2. Grant access to both Workload Identity SAs (tesserix + mark8ly admin)
3. Sync ArgoCD `company` and `mark8ly-admin` apps after the next image roll

---

## Pending work — pick up in priority order

### A. Phase 5.5 — Mark8ly admin merchant UI ✅ implemented (uncommitted)

All code is in place across three repos. **Pending manual step:** create the GSM secret + grant WIF access (see "Still needed" above).

**Files added/changed (uncommitted):**

`tesserix-home/`
- `app/api/internal/platform-announcements/route.ts` — new GET endpoint (bearer auth)
- `.planning/HANDOFF.md` — this file

`tesserix-k8s/`
- `charts/apps/company/templates/externalsecret.yaml` — adds `INTERNAL_API_TOKEN` from `prod-tesserix-internal-api-token`
- `charts/apps/mark8ly-admin/values.yaml` — new `tesserixInternal` block
- `charts/apps/mark8ly-admin/templates/externalsecret.yaml` — new ExternalSecret in mark8ly namespace
- `charts/apps/mark8ly-admin/templates/deployment.yaml` — env wiring for `INTERNAL_API_TOKEN` + `TESSERIX_INTERNAL_URL`

`mark8ly/`
- `apps/admin/lib/api/tesserix.ts` — client (`filePlatformTicket`, `listMyPlatformTickets`, `listActivePlatformAnnouncements`)
- `apps/admin/app/(admin)/support/platform/page.tsx` — new merchant page
- `apps/admin/app/(admin)/support/platform/actions.ts` — server action
- `apps/admin/app/api/platform-announcements/route.ts` — server proxy for the banner client
- `apps/admin/components/support/PlatformTicketForm.tsx` — client form
- `apps/admin/components/shell/banners/PlatformAnnouncementBanner.tsx` — client banner with localStorage dismissal
- `apps/admin/components/shell/AdminShell.tsx` — sidebar entry + page-title eyebrow + banner mount

**Verification once redeployed:**
1. Sign in to mark8ly admin as a merchant; nav to Support → Platform support
2. File a test ticket; confirm it appears in tesserix-home `/admin/platform-tickets`
3. In tesserix-home `/admin/platform-announcements`, publish an announcement; confirm it appears as a banner across mark8ly admin within 5 minutes

### B. Phase 5.6 — Reply flow (both sides)

After 5.5:
- Add `POST /api/internal/platform-tickets/[id]/replies` in tesserix-home (merchant reply, bearer auth)
- Add `POST /api/admin/platform-tickets/[id]/replies` in tesserix-home (super-admin reply, session auth)
- Detail page in tesserix-home: `/admin/platform-tickets/[id]` with thread + composer (per `.planning/phases/05-platform-comms/UX-SPEC.md`)
- mark8ly admin: ticket detail page with thread + composer
- Email notifications when other side replies (depends on Phase 1 Wave 1.5)

### C. Phase 1 Wave 5 — mark8ly send-site `custom_args` instrumentation

Six files across three mark8ly services. Metadata-only, additive. Required to light up email metrics per-tenant in tesserix-home dashboards.

| Service | File(s) |
|---|---|
| `../mark8ly/services/platform-api` | `internal/notification/sendgrid.go` (single chokepoint) |
| `../mark8ly/services/marketplace-api` | `internal/orderdoc/mailer.go`, `internal/campaign/sendgrid_dispatcher.go`, `internal/giftcard/mailer.go`, `internal/shipping/labelmailer.go` |
| `../mark8ly/services/otto` | `internal/mailer/sendgrid.go` |

For each: add `CustomArgs map[string]string{"tenant_id": ..., "product": "mark8ly"}` to the SendGrid request struct. One PR per service. Verify in SendGrid Activity post-deploy.

### D. Phase 1 Wave 1.5 — `notification-service` email_events ingestion

**Blocked on:** SendGrid Event Webhook signing key configured in SendGrid console + stored in GSM as `notification-service-sendgrid-webhook-secret`.

After signing key is set:
- Add migration in `../notification-service/migrations` for `email_events` table (schema in `.planning/phases/01-resources-cost-dashboards/PLAN.md` Wave 1.5)
- Add `POST /webhooks/sendgrid` receiver with HMAC verify
- Add `GET /internal/email-events/aggregate` for tesserix-home to query
- Update tesserix-home `lib/metrics/email-events.ts` to call notification-service instead of returning zeros

### E. Phase 2 — Confirm pricing constants

`lib/products/configs.ts` has placeholder mark8ly prices in AUD: `{trial: 0, starter: 29, studio: 79, pro: 149, marketplace: 299}`. **These were USD numbers I labeled AUD.** Real values must be confirmed against Stripe before MRR/ARR is meaningful in any reporting downstream.

### F. Phase 3 — Templates Registry + Lead Marketing Send

Plan written but not started. Lower priority while leads pipeline is empty.

### G. Other backlog items

See `BACKLOG.md` at repo root. Highlights:
- F1 — Cross-product user search (high support unlock, ~3 waves)
- E1 — Onboarding funnel visibility (reads mark8ly `onboarding_sessions`, etc.)
- M1 — Synthetic uptime per tenant subdomain
- O1 — New product onboarding wizard
- **P** (NEW, parked) — Centralized pricing & discounts initiative (P1–P5). Tesserix-home becomes the authoring surface for plan catalogs + promo codes; Stripe stays the billing engine. Affects mark8ly's `marketplace-api/internal/billing/pricing/catalog.go`, `mark8ly/packages/ui/src/subscription/pricing-data.ts`, and `tesserix-home/lib/products/configs.ts`. P2/P3a are HIGH risk (touches live billing) — staged rollout. See BACKLOG.md → §P for the full phase breakdown.

---

## Operational state — secrets, grants, env vars

### Already provisioned
- ✅ `mark8ly-platform-admin` secret in `tesserix` namespace (cross-DB password)
- ✅ `tesserix-postgres-tesserix-admin` secret (tesserix-postgres `tesserix_admin` role password)
- ✅ Cross-DB grants on mark8ly billing tables (`store_subscriptions`, `stripe_webhook_events`, `subscription_plan_change_audit`, `billing_archive`)
- ✅ Cross-DB grants on mark8ly tickets/audit (`tickets`, `ticket_replies`, `audit_logs`)
- ✅ Cross-DB grants on mark8ly tenant tables (`stores`, `orders`, `products`, `customer_profiles`)
- ✅ NetworkPolicy: company → opencost egress (Phase 1)
- ✅ tesserix-home env vars: `PROMETHEUS_URL`, `OPENCOST_URL`, `MARK8LY_DB_*`
- ✅ Migration `0002_platform_comms.sql` applied to tesserix-postgres `tesserix_admin` database (tables in `public` schema)

### Still needed
- ⏳ Create GSM secret `prod-tesserix-internal-api-token` and grant WIF access to both SAs (Phase 5.5 — chart wiring is in place; secret is the only manual step)
- ⏳ SendGrid Event Webhook signing key in GSM as `notification-service-sendgrid-webhook-secret` (Phase 1 Wave 1.5)
- ⏳ Egress path validated: mark8ly admin currently calls `https://tesserix.app/...` (external HTTPS via Cloudflare). To switch to in-cluster (cheaper), add `mark8ly` to the company AuthorizationPolicy `allow-ingress-to-tesserix` allowed sources and flip `tesserixInternal.url` to `http://company.tesserix.svc.cluster.local`

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
| Cross-DB query helpers | `lib/db/{mark8ly,tesserix,mark8ly-billing,mark8ly-audit,mark8ly-tenant-metrics,platform-tickets,platform-announcements}.ts` |
| Metric aggregators | `lib/metrics/{prometheus,opencost,product-metrics,tenant-metrics,cost-proxy,revenue,margin,trial-likelihood,email-events,window}.ts` |
| ProductConfig | `lib/products/{types,configs}.ts` |
| Admin SWR hooks | `lib/admin/{use-metrics,use-billing,use-audit}.ts` |
| Admin pages | `app/admin/**/*.tsx` |
| API routes | `app/api/admin/**`, `app/api/internal/**` |
| UI primitives | `components/admin/{metrics,billing,audit,tickets/...}/*.tsx` |
| Layouts | `components/admin/{product-overview,tenant-detail,subscriptions-page,audit-logs-page}-layout.tsx` |
| Sidebar | `components/admin/sidebar.tsx` |
| DB migrations | `db/migrations/000[1-2]_*.sql` |
| Sibling repo pointers | `../mark8ly/`, `../tesserix-k8s/`, `../notification-service/` |

---

## Suggested next-session opener

"Read `.planning/HANDOFF.md`. Phase 5.5 is implemented but uncommitted across three repos (tesserix-home, tesserix-k8s, mark8ly). Walk the diffs in each repo, then commit per-repo with conventional-commit messages. Once committed, redeploy after the operator creates the GSM secret."

Or to start the next phase:

"Read `.planning/HANDOFF.md`. Pick up Phase 5.6 — reply flow on both sides. Start with `POST /api/internal/platform-tickets/[id]/replies` (bearer-authed, merchant reply) in tesserix-home, then the super-admin reply route + ticket detail page."

Or for a different priority:

"Read `.planning/HANDOFF.md`. Confirm Phase 2 pricing constants against Stripe (`lib/products/configs.ts`). Then take on Phase 1 Wave 5 — mark8ly `custom_args` instrumentation in `mark8ly/services/platform-api/internal/notification/sendgrid.go` first (single chokepoint, lowest risk)."
