# Handoff — Tesserix super-admin tool

**Last session:** 2026-05-01 — through commit `0df851b`
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

---

## Pending work — pick up in priority order

### A. Phase 5.5 — Mark8ly admin merchant UI (cross-repo)

**Repo:** `../mark8ly/apps/admin` (Next.js, App Router, route group `(admin)`)
**What to add:**

1. **`INTERNAL_API_TOKEN` env var on both apps** (shared bearer token for tesserix-home internal endpoints):
   - tesserix-home: add to `tesserix-k8s/charts/apps/company/values.yaml` env block (or as ESO secret)
   - mark8ly admin: add to mark8ly admin's chart values
   - Generate one secret value, populate both via GSM/ESO

2. **mark8ly admin client** (`../mark8ly/apps/admin/lib/tesserix.ts` or similar):
   - `filePlatformTicket(input)` — POST to `https://tesserix.app/api/internal/platform-tickets` (URL via `TESSERIX_INTERNAL_URL` env)
   - `listMyPlatformTickets(productId, tenantId)` — GET with same auth
   - Forwards `Authorization: Bearer ${INTERNAL_API_TOKEN}`

3. **mark8ly admin page**: new route `app/(admin)/support/platform/page.tsx`:
   - Form: subject, description, priority — submits via `filePlatformTicket`
   - List below: my tickets (status, ticket_number, last_updated)
   - Sidebar nav: add "Platform support" entry under Support

4. **Network policy check**: verify mark8ly admin pod can egress to tesserix namespace. If not, add to `tesserix-k8s/charts/apps/mark8ly-admin/templates/network-policy.yaml`. (Mirror the OpenCost egress fix from Phase 1.)

5. **Active announcements banner** (deferred to 5.6 if budget tight):
   - mark8ly admin reads from `GET /api/internal/platform-announcements` (endpoint to be added in tesserix-home — symmetric to platform-tickets one)
   - Banner component lives in `app/(admin)/layout.tsx` or near the top of dashboard

**Phase 5.5 acceptance:** A merchant in mark8ly admin can navigate to /support/platform, file a ticket, see it appear in tesserix-home's `/admin/platform-tickets`.

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
- ⏳ `INTERNAL_API_TOKEN` env var on both tesserix-home + mark8ly admin (Phase 5.5)
- ⏳ SendGrid Event Webhook signing key in GSM as `notification-service-sendgrid-webhook-secret` (Phase 1 Wave 1.5)
- ⏳ NetworkPolicy: mark8ly admin → tesserix egress (verify when 5.5 begins)

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

"Read `.planning/HANDOFF.md`. Then pick up Phase 5.5 (mark8ly admin merchant UI for platform tickets). Start with provisioning the shared `INTERNAL_API_TOKEN` and writing the mark8ly client + page, then the active announcements banner."

Or for a different priority:

"Read `.planning/HANDOFF.md`. Confirm Phase 2 pricing constants against Stripe (`lib/products/configs.ts`). Then take on Phase 1 Wave 5 — mark8ly `custom_args` instrumentation in `mark8ly/services/platform-api/internal/notification/sendgrid.go` first (single chokepoint, lowest risk)."
