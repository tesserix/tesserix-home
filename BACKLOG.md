# Tesserix Super-Admin Backlog

Consolidated feature backlog from architecture conversations. Items tagged with **★** are picked for early phases. Patterns: **FR** (federated read — cross-DB SELECT), **FW** (federated write — call product API), **SR** (shared registry — products consume from platform), **NA** (new ask, doesn't exist anywhere).

---

## Architectural patterns

| Pattern | Mechanism | Examples |
|---|---|---|
| Federated read (FR) | `tesserix_admin` role SELECTs product DB; tesserix-home renders | Tenants ✓, Subscriptions, Audit logs, Tickets list |
| Federated write (FW) | tesserix-home calls product's API as platform-admin | Tenant suspend, Ticket reply |
| Shared registry (SR) | Platform owns canonical data; products fetch via API/cache | Templates, Config defaults, Announcements |
| New ask (NA) | New table/service in tesserix-home or notification-service | Lead invites, GDPR queue UI, Synthetic uptime |

---

## Phase plan (locked through Phase 3, suggested beyond)

| Phase | Scope | Daily use? | Risk to mark8ly |
|---|---|---|---|
| **1** | **Resources + Cost dashboards** (K1, K2, K4, L1, L2) | Daily | None — all read-only |
| **2** | **Tickets + Audit Logs** (A2, A7) | Daily | Low (FW writes via mark8ly API) |
| **3** | **Templates Registry + Lead Marketing Send** (B1, B2) | Daily-Weekly | None (mark8ly send paths untouched) |
| 4 | Subscriptions + Trial Management (A1, N1) | Weekly | None (FR) |
| 5 | Onboarding Funnel + Notification Log (E1, E2) | Weekly | None (FR) |
| 6 | Cross-product User Search + Synthetic Uptime (F1, M1) | Weekly | None |
| 7+ | Templates rewire (B3), GCP Billing Export (L3), governance | As needed | Med (B3 touches send paths) |

---

## Backlog by category

### A. Cross-product visibility (FR pattern)

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| A1 | Subscriptions & dunning page | FR | None | M |
| ★ A2 | Audit log explorer | FR | None | M |
| A4 | Stripe webhook health | FR | Low | M |
| A5 | Otto chat metrics (MongoDB) | FR (different DB) | Low | L |
| A6 | Platform dashboard rework — cross-product instead of mark8ly-flavored | NA | None | S |
| ★ A7 | Tickets — federated read | FR | None | M |
| A7w | Tickets — reply via mark8ly API | FW | Low | S |

### B. Email + comms platform

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ B1 | Templates Registry (read-only canon) — extend `notification-service.templates` with `product_id`+`kind`+`key`; seed 10 mark8ly templates | SR | None | M |
| ★ B2 | Lead invite/marketing send — Mark8ly Leads page → marketing template → notification-service | NA | None | M |
| B3 | Rewire mark8ly transactional sends to fetch from registry (with embedded HTML fallback) | SR | **High** | M-L |
| B4 | Campaign scheduling, unsubscribe, tracking | NA | None | L |

### C. Configuration / multi-tenancy (parked)

| # | Feature | Blocked on |
|---|---|---|
| C1 | Platform/product/tenant config inheritance UI | Tesserix billing model decision; secret storage decision |
| C2 | Tenant-level Stripe (Stripe Connect onboarding) | C1 + Stripe Connect architecture |
| C3 | Tenant-level SendGrid sender identity | C1 + DNS/verification flow |

### E. Operational visibility

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ E1 | Onboarding funnel — tenants in flight, drop-offs (`onboarding`, `verifications`, `invitations`) | FR | None | M |
| ★ E2 | Notification log — every email sent, with status | FR | None | M |
| E3 | Service health snapshot (Prometheus already collecting) | New (Prom proxy) | Low | M |
| E4 | CNPG cluster health per product (replication lag, WAL, connections) | Prom proxy | Low | S |
| E5 | Outbox events monitor (mark8ly `outbox_events` stuck rows) | FR | Low | S |
| E6 | Cron / scheduled job status (dunning ladder, backups, audit-service) | FR | Low | M |

### F. Trust, support, compliance

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ F1 | Cross-product user search — one email → everywhere | FR | Low | M |
| F2 | Tenant "view as" (read-only impersonation) | FR + new auth | High | L |
| ★ F3 | GDPR / erasure request queue (`customer_erasure_requests` already in mark8ly) | FR + FW | Low | S |
| F4 | Break-glass account audit (`break_glass_accounts`) | FR | Low | S |
| F5 | API key inventory + expiry tracker (`api_keys`) | FR | Low | S |

### G. Revenue & growth

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| G1 | MRR / ARR / churn analytics (depends on A1) | FR | Low | M |
| G2 | Top tenants by GMV / orders | FR | Low | S |
| G3 | Lead → tenant conversion funnel | NA | Low | M |

### H. Platform governance

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| H1 | Feature flag explorer + per-tenant overrides (feature-flags-service exists) | FR + FW | Med | M |
| H2 | Per-tenant kill switch / suspend with reason codes | FW | Med | S |
| H3 | Platform admin team management (super-admins, MFA, last sign-in) | NA | Low | S |

### I. Comms & broadcast

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| I1 | In-app announcement broadcast (banner to all merchant admins) | SR | Low | M |
| I2 | Public status page generator | New infra | Med | M |
| I3 | Tenant-targeted push notification sender | FW | Low | S |

### J. Dev / ops aids

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| J1 | Recent deployments timeline (commit → image → rollout per service) | New infra (gh+ArgoCD) | Low | M |
| J2 | Migration runner UI | FW | High | L |

### K. Resources & metrics (PHASE 1)

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ K1 | **Per-product resource dashboard** — CPU/memory/pods/DB on Mark8ly Overview (Prometheus + CNPG metrics) | New (Prom proxy) | Low | M |
| ★ K2 | **Per-tenant activity panel** — DB storage, row counts, request rate, bandwidth on tenant detail | FR + Prom by tenant label | Low | M |
| K3 | Cluster fleet view — all 6 product DB clusters' health | Prom proxy | Low | S |
| ★ K4 | **Email volume metrics** (sent/delivered/opens/bounces) per product + tenant via SendGrid Activity API + custom_args | New (SG proxy) | Low | M |
| K5 | Top tenants by email volume / bounce rate | Same as K4 | Low | S |

### L. Cost attribution (PHASE 1)

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ L1 | **Per-product cost dashboard** — OpenCost API by namespace | New (OpenCost proxy) | Low | S |
| ★ L2 | **Per-tenant cost proxy** — product cost × tenant activity share, with breakdown of basis | Derived | Low | M |
| L3 | GCP Billing Export → BigQuery + non-K8s cost attribution | Terraform + new query layer | Med | M |
| L4 | Cost trend & forecasting; anomaly flags | New | Low | M |
| L5 | External SaaS cost attribution (SendGrid spend per tenant) | Vendor APIs | Low | M |

### M. Tenant-facing health (from outside)

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ M1 | Synthetic uptime monitoring per tenant subdomain | NA | Low | S |
| M2 | Custom-domain DNS verification dashboard | NA | Low | M |
| M3 | Tenant storefront RUM (page load times) | New infra | Low | M |

### N. Tenant lifecycle

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ N1 | Trial management — tenants in trial, days left, conversion likelihood | FR | Low | S |
| N2 | Plan upgrade/downgrade history per tenant | FR | Low | S |
| N3 | Usage caps & overage alerts | FR + new logic | Low | M |
| N4 | Tenant offboarding workflow — cancellation reason, retention timer | FW | Med | M |

### O. Platform-team productivity & integrations

| # | Feature | Pattern | Risk | Effort |
|---|---|---|---|---|
| ★ O1 | New product onboarding wizard — UI flow for namespace+CNPG+OpenFGA setup | NA | Low | L |
| O2 | Database backup health dashboard (CNPG ScheduledBackup status) | Prom proxy | Low | S |
| O3 | Global command palette (Cmd+K) | NA | None | S |
| O4 | Slack/Discord/email alerting for critical events | NA | Low | S |
| O5 | Outbound webhook configuration | NA | Low | M |
| O6 | Public changelog per product | NA | Low | S |
| O7 | Failed login / auth-anomaly tracker | FR | Low | M |
| O8 | Image dependency vulnerability dashboard | FR (Trivy) | Low | M |

### O.deferred (not now)

| # | Feature | Reason |
|---|---|---|
| O9 | AI assistant for admin (NL queries) | After core data layer is solid |
| O10 | API documentation portal | Better tools exist (Mintlify) |
| O11 | Slow query / N+1 detector | pg_stat_statements + Grafana already does this |

---

## Open architectural decisions

- [ ] Tesserix billing model — does Tesserix charge merchants directly (need platform Stripe), or is Stripe purely product-level?
- [ ] Override secret storage — per-tenant GSM secrets vs KMS-encrypted in Postgres
- [ ] Cost share basis for L2 — request count only, composite (50/30/20), or per-product configurable
- [ ] GCP Billing Export setup — Phase 1 or Phase 4
- [ ] Prometheus / OpenCost auth from tesserix-home — new SA + token, or ingress with admin auth
- [ ] SendGrid plan tier — confirm Activity API access

## Done this session

- ✓ Mark8ly route isolation under `/admin/apps/mark8ly/{tenants,leads}`
- ✓ Sidebar split into Platform / Mark8ly rails
- ✓ Native `<select>` → `@tesserix/web` Select migration

---

## Design approach

- **tesserix-home is a Modern clean admin tool**, NOT the Mark8ly editorial brand. (See `~/.claude/projects/.../memory/project_design_direction.md`)
- UI design assistance: `ux-design-specialist` agent + impeccable design skills (`frontend-design`, `arrange`, `polish`, `clarify`, `harden`).
- Component library: `@tesserix/web` (shadcn/Radix-based) for primitives; build admin compositions in `components/admin/`.
- Charts: `recharts` already used in `marketplace-admin` — reuse for consistency.
