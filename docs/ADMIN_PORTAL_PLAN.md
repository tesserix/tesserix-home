# Admin Portal Implementation Plan

## Overview

Tesserix Home (`tesserix.app`) serves dual purposes: the public marketing site and the internal admin portal for managing Mark8ly tenants, support tickets, and platform operations. The admin portal lives under `app/admin/` with all routes served at `/admin/*` (e.g., `/admin/dashboard`, `/admin/tenants`, `/admin/tickets`).

## Current State

### What Already Exists

**UI Pages (all using mock/hardcoded data):**
- `app/(admin)/dashboard/page.tsx` — Stats grid + recent tenants/tickets
- `app/(admin)/tenants/page.tsx` — Tenant list with search/filter
- `app/(admin)/tenants/[id]/page.tsx` — Tenant detail with tabs (Overview, Settings, Billing, Activity)
- `app/(admin)/tickets/page.tsx` — Ticket list with search/filter/priority
- `app/(admin)/tickets/[id]/page.tsx` — Ticket detail with comments + status management
- `app/(admin)/layout.tsx` — AuthProvider + AdminSidebar wrapper
- `components/admin/sidebar.tsx` — Navigation sidebar with user info
- `components/admin/header.tsx` — Sticky admin header
- `components/admin/stats-card.tsx` — Reusable stats card

**Auth Infrastructure:**
- `middleware.ts` — Session cookie check, redirects unauthenticated users to `/login`
- `lib/auth/config.ts` — BFF endpoints, public/admin path config
- `lib/auth/auth-client.ts` — Session management (getSession, login, logout, refresh)
- `lib/auth/auth-context.tsx` — AuthProvider, useAuth, useHasRole hooks
- `app/api/auth/[...path]/route.ts` — Proxy to auth-bff service
- `app/login/page.tsx` — Login form

**API Routes (mock data only):**
- `app/api/tenants/route.ts` — Returns hardcoded tenant list
- `app/api/tickets/route.ts` — Returns hardcoded ticket list

**K8s / Infrastructure:**
- Helm chart at `tesserix-k8s/charts/apps/company/` with env vars:
  - `TENANT_SERVICE_URL=http://tenant-service.marketplace.svc.cluster.local:8080`
  - `TICKETS_SERVICE_URL=http://tickets-service.marketplace.svc.cluster.local:8080/api/v1`
  - `AUTH_BFF_URL=http://auth-bff.marketplace.svc.cluster.local:8080`
- VirtualService routes `/auth/*` to auth-bff for OIDC login flow
- ArgoCD app at `argocd/prod/apps/global/company.yaml`

**Backend Services (already running in K8s):**
- `tenant-service` (Go) — Full CRUD, membership, slug management, onboarding
- `tickets-service` (Go) — Full CRUD, comments, status transitions, email notifications
- `auth-bff` (Node.js) — OIDC proxy to Keycloak dual realms
- `notification-service` (Go) — Email templates for ticket status changes

### What Was Missing (at project start, now mostly resolved)

1. ~~API routes are mock — not connected to real backend services~~ → Fixed in Phase 1
2. ~~Admin pages use hardcoded data — not fetching from API~~ → Fixed in Phase 1
3. ~~No loading/error states in admin pages~~ → Fixed in Phase 1
4. ~~No pagination support~~ → Fixed in Phase 1
5. ~~Session cookie name mismatch~~ → Fixed in Phase 1
6. ~~No server-side auth validation in API routes~~ → Fixed in Phase 1
7. Tenant detail tabs (Settings, Billing, Activity) — still placeholders (see Pending Items)
8. ~~No "Visit Store" link logic~~ → Fixed in Phase 1

---

## Phase 1: Wire Up Real Data (MVP) — COMPLETED

**Status:** All steps completed. Commits: `e9d6b57`, `8dce143`, `9eb7ec5e`

**Goal:** Replace all mock data with real API calls. Make the admin portal functional with live data from tenant-service and tickets-service.

### Step 1: Fix Auth Cookie & Add API Auth Helper

**Problem:** Middleware checks for `session` cookie but auth-bff sets `bff_session`.

**Files:**
- `middleware.ts` — Change cookie name from `session` to `bff_session`
- `lib/api/admin-fetch.ts` (new) — Server-side fetch helper that:
  - Reads `bff_session` cookie from the request
  - Forwards it to backend services
  - Handles 401 responses (redirect to login)
  - Adds standard headers (Content-Type, X-Internal-Service)

### Step 2: Replace Mock API Routes with Real Proxies

Replace mock data in API routes with proxies to real backend services.

**Files to modify:**

`app/api/tenants/route.ts` — Proxy to tenant-service:
- GET `/api/tenants` → `TENANT_SERVICE_URL/api/v1/users/me/tenants` (platform admin gets all)
- POST `/api/tenants` → `TENANT_SERVICE_URL/api/v1/tenants/create-for-user`

`app/api/tenants/[id]/route.ts` (new) — Single tenant operations:
- GET `/api/tenants/:id` → `TENANT_SERVICE_URL/internal/tenants/:id`
- DELETE `/api/tenants/:id` → `TENANT_SERVICE_URL/api/v1/tenants/:id`

`app/api/tickets/route.ts` — Proxy to tickets-service:
- GET `/api/tickets` → `TICKETS_SERVICE_URL/tickets` (with query params)
- POST `/api/tickets` → `TICKETS_SERVICE_URL/tickets`

`app/api/tickets/[id]/route.ts` (new) — Single ticket operations:
- GET `/api/tickets/:id` → `TICKETS_SERVICE_URL/tickets/:id`
- PUT `/api/tickets/:id` → `TICKETS_SERVICE_URL/tickets/:id`

`app/api/tickets/[id]/status/route.ts` (new) — Ticket status updates:
- PUT `/api/tickets/:id/status` → `TICKETS_SERVICE_URL/tickets/:id/status`

`app/api/tickets/[id]/comments/route.ts` (new) — Ticket comments:
- POST `/api/tickets/:id/comments` → `TICKETS_SERVICE_URL/tickets/:id/comments`

### Step 3: Add Data Fetching Hooks

Create reusable hooks for data fetching with loading, error, and pagination states.

**Files:**

`lib/api/use-api.ts` (new) — Generic fetch hook:
- `useApi<T>(url, options)` — SWR-like hook with fetch, loading, error, mutate
- Handles auth errors (401 → redirect to login)
- Supports query params for filtering/pagination

`lib/api/tenants.ts` (new) — Tenant-specific API functions:
- `useTenants(filters)` — List tenants with search/status/pagination
- `useTenant(id)` — Single tenant detail
- `deleteTenant(id)` — Delete tenant

`lib/api/tickets.ts` (new) — Ticket-specific API functions:
- `useTickets(filters)` — List tickets with search/status/priority/pagination
- `useTicket(id)` — Single ticket detail
- `updateTicketStatus(id, status)` — Change ticket status
- `addComment(id, content)` — Add comment to ticket

### Step 4: Wire Up Dashboard Page

Replace hardcoded stats and recent items with real API data.

**File:** `app/(admin)/dashboard/page.tsx`
- Fetch tenant count from `/api/tenants?limit=1` (get total from response)
- Fetch open ticket count from `/api/tickets?status=open&limit=1`
- Fetch recent tenants from `/api/tenants?limit=4&sort=created_at:desc`
- Fetch recent tickets from `/api/tickets?limit=4&sort=updated_at:desc`
- Add loading skeletons while data loads
- Add error states with retry

### Step 5: Wire Up Tenants List Page

**File:** `app/(admin)/tenants/page.tsx`
- Replace hardcoded array with `useTenants()` hook
- Wire search input to debounced API query
- Wire status filter to API query
- Implement real pagination (Previous/Next buttons)
- Add loading skeleton for table
- Add empty state when no tenants found
- Wire "Visit Store" link to `https://{slug}.{BASE_DOMAIN}`

### Step 6: Wire Up Tenant Detail Page

**File:** `app/(admin)/tenants/[id]/page.tsx`
- Fetch tenant by ID from `/api/tenants/:id`
- Show real tenant data (name, slug, email, status, plan, domain, etc.)
- Wire "Visit Store" button to real URL
- Wire Suspend/Activate buttons to real API calls
- Add loading state
- Add 404 handling for invalid tenant IDs

### Step 7: Wire Up Tickets List Page

**File:** `app/(admin)/tickets/page.tsx`
- Replace hardcoded array with `useTickets()` hook
- Wire search, status filter, priority filter to API queries
- Implement real pagination
- Wire action dropdown items (Mark as In Progress, Resolved, Close) to status API
- Add loading skeleton
- Add empty state

### Step 8: Wire Up Ticket Detail Page

**File:** `app/(admin)/tickets/[id]/page.tsx`
- Fetch ticket by ID from `/api/tickets/:id`
- Display real ticket data with comments
- Wire comment form to POST `/api/tickets/:id/comments`
- Wire status dropdown to PUT `/api/tickets/:id/status`
- Add loading state
- Add optimistic UI updates for comments and status changes

### Step 9: Add Loading & Error Components

**Files:**
- `components/admin/table-skeleton.tsx` (new) — Skeleton for data tables
- `components/admin/error-state.tsx` (new) — Error display with retry button
- `components/admin/empty-state.tsx` (new) — Empty state for lists

### Step 10: Build Verification & Testing

- `npm run build` — Ensure no build errors
- Test with `NEXT_PUBLIC_DEV_AUTH_BYPASS=true` locally
- Verify API proxy routes work with backend services
- Test pagination, search, filtering
- Test ticket status changes and comments
- Test auth flow (login → dashboard → logout)

---

## Phase 2: Content Management — COMPLETED

**Status:** All steps completed. Platform admins can now manage content pages (About, FAQ, Privacy Policy, Blog, etc.) for any tenant's storefront via the admin portal.

**Architecture:** Content pages are stored in `settings-service` as JSONB in `storefront_theme_settings.ecommerce.contentPages`. The admin portal proxies to the marketplace settings-service via `MARKETPLACE_SETTINGS_SERVICE_URL`. PATCH requests only send `contentPages`, preserving theme/style settings.

### What Was Built

**Infrastructure:**
- Added `MARKETPLACE_SETTINGS_SERVICE_URL` to `admin-fetch.ts` (service type: `'settings'`)
- Added `/content` to middleware `ADMIN_PATHS` for auth protection
- Added K8s env var: `MARKETPLACE_SETTINGS_SERVICE_URL=http://settings-service.marketplace.svc.cluster.local:8085/api/v1`

**API Layer:**
- `app/api/content/route.ts` — GET/PATCH proxy to settings-service `/storefront-theme/{tenantId}`
- `lib/api/content.ts` — Types (`ContentPage`, `ContentPageType`, `ContentPageStatus`), hooks (`useContentPages`, `saveContentPages`), helpers (`createPage`, `updatePage`, `deletePage`, `publishPage`, `unpublishPage`, `archivePage`, `generateSlug`)

**UI Components:**
- `components/admin/tenant-selector.tsx` — Reusable tenant dropdown (used by content pages, reusable for future cross-tenant features)
- `components/ui/rich-text-editor.tsx` — TipTap editor with full toolbar (bold, italic, underline, strike, highlight, headings, lists, blockquote, code, alignment, links, images), character count footer

**Pages:**
- `app/(admin)/content/page.tsx` — Content pages list with tenant selector, search, type/status filters, table with inline actions (edit, publish, unpublish, archive, delete)
- `app/(admin)/content/[id]/page.tsx` — Two-column editor: left (title, slug, rich text, excerpt), right (status + actions, page type, display options, SEO fields, stats)
- Sidebar updated with "Content" nav item

**TipTap Dependencies Added:**
- `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/extension-image`, `@tiptap/extension-placeholder`, `@tiptap/extension-text-align`, `@tiptap/extension-underline`, `@tiptap/extension-highlight`, `@tiptap/pm`

### Deferred → See Pending Items

## Phase 3: Subscription & Billing — COMPLETED

**Status:** All steps completed. Commit: `3bb12ab`

**Architecture:** Subscription plans and tenant subscriptions are managed by `subscription-service` (Go) in global-services. The admin portal proxies to it via `SUBSCRIPTION_SERVICE_URL`. Stripe integration is handled server-side by subscription-service.

### What Was Built

**Infrastructure:**
- Added `SUBSCRIPTION_SERVICE_URL` to `admin-fetch.ts` (service type: `'subscription'`)
- Added `/billing` to middleware `ADMIN_PATHS` for auth protection
- Added K8s env var: `SUBSCRIPTION_SERVICE_URL=http://subscription-service.marketplace.svc.cluster.local:8080/api/v1`

**API Layer:**
- `app/api/subscriptions/plans/route.ts` — GET/POST proxy to subscription-service `/plans`
- `lib/api/subscriptions.ts` — Types, hooks (`usePlans`, `useSubscriptions`), mutation helpers

**Pages:**
- `app/(admin)/billing/page.tsx` — Subscription plans list, tenant subscription management
- Sidebar updated with "Billing" nav item

### Deferred → See Pending Items

## Platform Migration: tickets-service — COMPLETED

**Status:** Completed 2026-02-09.

Moved `tickets-service` from `marketplace-services` to `global-services` — it's a platform concern (support tickets for Mark8ly itself), not tenant-specific marketplace logic.

### What Changed
- **global-services:** Copied `tickets-service/` directory (Go code, migrations, Dockerfile) and CI/CD workflows
- **tesserix-k8s:** Updated `image.repository` in Helm values to `ghcr.io/tesseract-nexus/global-services/tickets-service`, moved ArgoCD apps from `marketplace/` to `global/` app-of-apps tree
- **marketplace-services:** Deleted `tickets-service/` directory and CI/CD workflows

### What Didn't Change
- K8s service DNS: still `tickets-service.marketplace.svc.cluster.local:8080` (deploys to `marketplace` namespace)
- No code changes in tesserix-home, marketplace-clients, or the Go service itself
- All consumers use `TICKETS_SERVICE_URL` env var — zero impact

## Phase 4: Tenant Self-Serve Onboarding (Next)

- Integrate Stripe Checkout into `marketplace-clients/tenant-onboarding` for self-serve subscription during onboarding
- Connect onboarding flow to subscription-service plan selection
- Payment confirmation → tenant provisioning pipeline

## Phase 5: Advanced Admin Features — COMPLETED

**Status:** All steps completed. Commit: `146eb6a` (tesserix-home), `9153a4b2` (tesserix-k8s)

**Architecture:** 4 new admin sections, each fronting an existing backend service. All follow the same BFF proxy pattern: `lib/api/*.ts` hooks → `app/api/**/route.ts` proxy routes → `adminFetch(service, path)` → backend service.

### What Was Built

**Infrastructure (Step 0):**
- Added 4 new services to `admin-fetch.ts`: `audit`, `status-dashboard`, `feature-flags`, `notification`
- Added 4 auth paths to `middleware.ts`: `/audit-logs`, `/system-health`, `/feature-flags`, `/email-templates`
- Added 4 sidebar nav items with icons (ScrollText, Activity, ToggleLeft, Mail)
- Added 4 K8s env vars to `values.yaml` + ArgoCD inline parameters (devtest + prod)

**Audit Log Viewer (Step 1) — 8 files:**
- `lib/api/audit-logs.ts` — Types (`AuditLog`, `AuditLogSummary`, `RetentionSettings`, `ComplianceReport`), hooks, mutations
- 6 API routes: list, detail, summary, compliance report, retention (GET/PUT), cleanup (POST)
- `app/(admin)/audit-logs/page.tsx` — Stats cards, event log table with search/severity filter, detail dialog, compliance tab with findings, retention settings card

**System Health Dashboard (Step 2) — 6 files:**
- `lib/api/system-health.ts` — Types (`SystemStatus`, `MonitoredService`, `Incident`), hooks
- 4 API routes: status, services list, service detail, incidents
- `app/(admin)/system-health/page.tsx` — Color-coded status banner, services grid (latency/uptime/health), active incidents with update timeline, 30s auto-refresh

**Feature Flags Management (Step 3) — 9 files:**
- `lib/api/feature-flags.ts` — Types (`FeatureFlag`, `Experiment`, `ExperimentVariant`), hooks, mutations (override/clear/evaluate)
- 6 API routes: list flags, evaluate, set override, clear override, list experiments, experiment detail
- `app/(admin)/feature-flags/page.tsx` — Tabs: flags table with override actions, experiments table with links
- `app/(admin)/feature-flags/[id]/page.tsx` — Experiment detail: variants as cards, metrics table (participants/conversions/rate)

**Email Templates (Step 4) — 9 files:**
- `lib/api/email-templates.ts` — Types (`EmailTemplate`, `Notification`), hooks, mutations (CRUD + test send)
- 6 API routes: templates CRUD, test send, notifications list/detail/status
- `app/(admin)/email-templates/page.tsx` — Tabs: templates table, notification log with delivery detail dialog
- `app/(admin)/email-templates/[id]/page.tsx` — Two-column editor (name/subject/variables/HTML body + status/type/test send cards), supports `/email-templates/new`

**File count:** 7 modified + 32 created = 39 total files (35 in tesserix-home + 3 in tesserix-k8s + plan doc)

## Phase 6: Future Enhancements

- Staff management (roles, permissions)
- Analytics dashboard (tenant growth, revenue metrics)
- Domain management (custom domain status, DNS verification)
- Content version history and AI generation
- Real-time notifications (WebSocket)

---

## Pending Items

Consolidated from deferred items across all completed phases.

### From Phase 1 (Wire Up Real Data)
- [ ] Suspend/Activate tenant buttons — UI-only, no API wired yet
- [ ] Tenant detail tabs (Settings, Billing, Activity) — still show "coming soon"
- [ ] Optimistic UI for ticket comments — currently full reload after submission

### From Phase 2 (Content Management)
- [ ] Image upload for content pages — URL-based only for now
- [ ] Theme/style editor — separate feature
- [ ] Content version history
- [ ] Storefront live preview
- [ ] AI content generation

### From Phase 3 (Subscription & Billing)
- [ ] Stripe Checkout integration for tenant self-serve onboarding (→ Phase 4)
- [ ] Invoice generation and history
- [ ] Usage metering dashboard

### From Phase 5 (Advanced Admin Features)
- [ ] Audit log export (CSV/JSON download)
- [ ] Feature flag creation/deletion via UI (currently read-only + override)
- [ ] Email template HTML preview pane (live render)
- [ ] System health historical charts (uptime over time)

### From Issue #1 — Admin Authentication ([GitHub #1](https://github.com/Tesseract-Nexus/tesserix-home/issues/1))
- [x] Login page with email/password
- [x] Integration with internal Keycloak IDP (tesserix-internal realm) via auth-bff
- [x] Session management with secure httpOnly cookies (bff_session)
- [ ] Role-based access (Super Admin, Support, Finance, Developer) — middleware + UI gating
- [ ] MFA support (TOTP/Passkeys) — Keycloak config + auth-bff flow
- [ ] Password reset flow
- [ ] Activity audit log for admin actions (audit-service exists, needs frontend wiring per user)
- [ ] Session expiry after inactivity (auth-bff supports refresh, no idle timeout yet)

### From Issue #2 — Ticket Management ([GitHub #2](https://github.com/Tesseract-Nexus/tesserix-home/issues/2))
- [x] Dashboard showing all incoming tickets from tenant admins
- [x] Ticket list with filters (status, priority)
- [ ] Ticket list filters: tenant, category, assignee
- [x] Ticket detail view with conversation thread
- [ ] Assign tickets to team members
- [x] Status workflow: Open → In Progress → On Hold → Resolved → Closed → Escalated
- [x] Priority levels: Low, Medium, High, Critical
- [ ] Internal notes (not visible to tenant)
- [ ] SLA tracking and overdue alerts
- [ ] Feature request board with voting/prioritization
- [ ] Bulk actions (assign, close, change priority)
- [ ] Email notifications on ticket status changes (backend exists in notification-service, needs frontend wiring)

### From marketplace-clients#31 — Tenant Support Submissions ([GitHub](https://github.com/Tesseract-Nexus/marketplace-clients/issues/31))
_The tenant-facing side (forms, sidebar) lives in marketplace-clients/admin. Below are only the tesserix-home items._
- [x] Dashboard view of all incoming tickets across tenants
- [x] Status management and response/comment thread
- [ ] View file attachments on tickets (screenshots, logs uploaded by tenant admins)
- [ ] Separate feature request view/board (distinct from support tickets)
- [ ] Ticket category filtering (Bug, Billing, Account, Integration, Feature Request, Enhancement)

### From Issue #3 — Stripe Payment Gateway ([GitHub #3](https://github.com/Tesseract-Nexus/tesserix-home/issues/3))
- [ ] Stripe Connect setup for receiving subscription payments
- [ ] Stripe webhook endpoint (`/api/webhooks/stripe`) with signature verification
- [x] Subscription plan management (view/list plans)
- [ ] Subscription plan management (create/edit plans from admin UI)
- [x] Invoice history per tenant (tenant detail billing tab)
- [ ] Invoice generation and management (automatic)
- [x] Payment history (MRR on dashboard, invoices in tenant detail)
- [ ] Revenue analytics (churn rate, growth, detailed MRR breakdown)
- [x] Cancel/reactivate subscriptions from admin UI
- [x] Stripe portal session link
- [ ] Failed payment handling and retry logic
- [ ] Refund processing from admin UI
- [ ] Tax calculation integration

---

## Architecture Notes

### Auth Flow
```
Browser → tesserix.app/dashboard
  → middleware.ts checks bff_session cookie
  → No cookie? Redirect to /login
  → /login → /auth/login (VirtualService routes to auth-bff)
  → auth-bff → Keycloak (tesserix-internal realm)
  → Keycloak login → callback → auth-bff sets bff_session cookie
  → Redirect back to /dashboard
```

### API Proxy Pattern (JWT Exchange)
```
Browser → /api/tenants (Next.js API route)
  → Reads bff_session cookie
  → Calls auth-bff /internal/get-token to exchange session for JWT
  → Forwards request to TENANT_SERVICE_URL with Authorization: Bearer <jwt>
  → Returns response to browser
```

**Important:** Backend Go services require JWT tokens (validated by Istio), NOT session cookies. The `admin-fetch.ts` helper exchanges the session cookie for a JWT via auth-bff's `/internal/get-token` endpoint, then forwards requests with `Authorization: Bearer` header.

All backend calls go through Next.js API routes (BFF pattern). The browser never calls backend services directly. This:
- Keeps service URLs internal (not exposed to client)
- Allows server-side auth validation via JWT exchange
- Provides a single point for error handling and response transformation

### Cross-Tenant Ticket Aggregation
```
Platform Admin views /tickets:
  → GET /api/tickets (Next.js route)
  → Fetch all tenant IDs via tenant-service /api/v1/users/me/tenants
  → For each tenant: GET tickets-service /tickets?tenant_id=X (parallel)
  → Merge, sort by updated_at desc, paginate client-side
  → Return aggregated results
```

**Reason:** tickets-service requires `tenant_id` on every request (fail-closed middleware). There's no cross-tenant view endpoint. Platform admins get an aggregated view by fetching tickets per-tenant in parallel.

### Data Isolation
- **tesserix-home** (platform admin) → Keycloak `tesserix-internal` realm → JWT with `platform-owner=true`
- **marketplace-clients** (tenant admin) → Keycloak `tesserix-customer` realm → JWT with `tenant_id`
- Same backend services, different JWT claims → different data returned
- No backend code was modified — all changes are in tesserix-home only

### Environment Variables
| Variable | Where Set | Purpose |
|----------|-----------|---------|
| `TENANT_SERVICE_URL` | K8s env / ArgoCD | Backend tenant service URL |
| `TICKETS_SERVICE_URL` | K8s env / ArgoCD | Backend tickets service URL |
| `AUTH_BFF_URL` | K8s env / ArgoCD | Auth BFF for session validation |
| `MARKETPLACE_SETTINGS_SERVICE_URL` | K8s env / ArgoCD | Marketplace settings service for content management |
| `SUBSCRIPTION_SERVICE_URL` | K8s env / ArgoCD | Subscription service for billing/plans |
| `AUDIT_SERVICE_URL` | K8s env / ArgoCD | Audit service for audit log viewer |
| `STATUS_DASHBOARD_SERVICE_URL` | K8s env / ArgoCD | Status dashboard service for system health |
| `FEATURE_FLAGS_SERVICE_URL` | K8s env / ArgoCD | Feature flags service for flag management |
| `NOTIFICATION_SERVICE_URL` | K8s env / ArgoCD | Notification service for email templates |
| `INTERNAL_SERVICE_KEY` | GCP Secret Manager → ExternalSecret | Auth key for auth-bff /internal/get-token |
| `NEXT_PUBLIC_DEV_AUTH_BYPASS` | Local .env only | Dev mode skip auth |
| `NEXT_PUBLIC_BASE_DOMAIN` | K8s env / ArgoCD | Base domain for tenant URLs |

