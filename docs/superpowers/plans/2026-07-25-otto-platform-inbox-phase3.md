# Otto Platform Support Inbox — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Tesserix admins a real, staff-side cross-tenant support inbox in the tesserix-home admin web app. Otto's `/api/v1/platform/otto/*` surface (Phase 1) and `@tesserix/otto-widget@0.6.0` platform mode (Phase 2) are already shipped; Phase 3 wires them together: a hardened admin proxy, a live-chat page mounting `OttoInbox` in platform mode, a sidebar link, removal of the customer-side chat bubble from admin, a minimal ticket-escalation affordance, the Istio route for the platform WS, and an audit-surface marker in otto so platform actions are distinguishable in per-tenant audit trails.

**Architecture:** A customer opens a chat in any product → a conversation is created in that product's otto tenant. Tesserix staff open `/admin/support/live-chat` in tesserix-home → the browser calls the same-origin `/api/admin/otto/*` proxy (Next.js route handler) which adds `X-Internal-Auth` + the admin's staff identity (`X-User-Id/Email/Name`) and forwards to otto's `/api/v1/platform/otto/*` cross-tenant surface. Real-time updates use WebSockets that leave the Next.js app and hit otto directly via an Istio VirtualService route on the tesserix-home host (`/api/v1/platform/otto/ws` and `/api/v1/platform/otto/conversations/:id/ws`), mirroring the storefront otto WS route the same host already has. Otto's `PlatformStaff` middleware marks each request with a `surface=platform` context key that `emitAudit` folds into the audit event `Meta`, so a platform accept/close is distinguishable from the tenant's own staff in that tenant's audit trail.

**Tech Stack:** Go 1.26 + Gin + MongoDB (otto); Next.js 16 + React 19 + TypeScript (tesserix-home apps/web); `@tesserix/otto-widget` 0.6.0; Istio VirtualService (tesserix-k8s Helm chart `company`); ArgoCD/Kargo deploy.

## Global Constraints

- **Cross-tenant surfaces never fall open.** The proxy is admin-session-gated (`getCurrentSession()`, which accepts BOTH the `tx_session` cookie and an `Authorization: Bearer` session — the SAME helper the other `/api/admin/*` routes use, so web and the Expo mobile admin both work) AND injects the mandatory `OTTO_INTERNAL_AUTH` secret. Otto's `PlatformStaff` denies on an empty secret or missing `X-User-Id`.
- **No new secrets.** `OTTO_URL` and `OTTO_INTERNAL_AUTH` are already provisioned in tesserix-home (used by `app/api/otto/[...path]/route.ts` and `app/api/admin/analytics/support/route.ts`). No new env, deployments, or charts.
- **Do NOT modify the widget in this phase.** `@tesserix/otto-widget@0.6.0` `OttoInbox` exposes no action-slot prop and no selected-conversation callback. Platform mode is enabled purely by the presence of the `tenantLabels` prop. Consume it as-is.
- **Copy the existing proxy's hardening verbatim** (path-traversal segment guard, host/prefix pinning, 64KB body cap, 10s upstream timeout, 5xx body suppression) from `app/api/otto/[...path]/route.ts`. The only differences: the auth gate (admin session, not anonymous), the upstream prefix (`/api/v1/platform/otto/`), the injected headers (staff identity, no tenant/store, no `otto_session` cookie).
- **lockfile discipline.** Bumping `@tesserix/otto-widget` requires regenerating `pnpm-lock.yaml` in the SAME commit — tesserix-home CI installs with `--frozen-lockfile` and fails otherwise.
- **Git identity (all three repos are under the `tesserix` org = personal identity):** `user.name "sam123ben"`, `user.email "samyak.rout@gmail.com"`. NEVER include any AI/Claude/Anthropic/Co-Authored-By reference in commits, PRs, comments, or file content. NEVER commit any CLAUDE.md.
- **No manual `kubectl apply` / no container builds by the implementer.** tesserix-k8s changes flow through ArgoCD; images are built by CI. Verify code with language tooling only (`go build/vet/test`, `pnpm lint/typecheck/build`, `helm template`).

## File Structure

```
# Repo A — slm-support-platform  (branch: feat/otto-audit-surface-marker)
services/otto/internal/auth/middleware.go            MODIFY — add CtxSurface + set it in PlatformStaff
services/otto/internal/conversation/admin_handler.go MODIFY — emitAudit folds surface into Meta
services/otto/internal/auth/middleware_test.go       MODIFY — 2 new tests (PlatformStaff sets it, StaffAuth does not)

# Repo B — tesserix-home  (branch: feat/otto-platform-inbox-ui)
apps/web/app/api/admin/otto/[...path]/route.ts               NEW  — hardened platform proxy
apps/web/components/admin/support/PlatformLiveChatInbox.tsx  NEW  — OttoInbox platform-mode wrapper
apps/web/app/admin/support/live-chat/page.tsx               NEW  — page (server component) + escalation bar
apps/web/components/admin/sidebar.tsx                        MODIFY — add "Live chat" nav entry
apps/web/app/admin/layout.tsx                               MODIFY — remove OttoSupportChat mount/import/wrapper
apps/web/package.json                                       MODIFY — @tesserix/otto-widget ^0.5.1 -> ^0.6.0
pnpm-lock.yaml                                              REGEN  — lockfile for the bump
# apps/web/components/OttoSupportChat.tsx  — LEFT IN PLACE (unmounted), per spec decision 2

# Repo C — tesserix-k8s  (branch: feat/otto-platform-inbox-vs OR direct main per norm)
charts/apps/company/templates/virtualservice.yaml           MODIFY — add platform-otto WS route before catch-all
```

---

### Task 1: Otto audit-surface marker (Repo A — slm-support-platform)

**Files:**
- Modify: `services/otto/internal/auth/middleware.go`
- Modify: `services/otto/internal/conversation/admin_handler.go`
- Modify: `services/otto/internal/auth/middleware_test.go`

**Interfaces:**
- Adds `auth.CtxSurface = "surface"` context key and `auth.SurfacePlatform = "platform"` constant.
- `PlatformStaff` sets `CtxSurface = SurfacePlatform`; `StaffAuth` leaves it unset.
- `AdminHandler.emitAudit` folds a non-empty `CtxSurface` into the audit event `Meta` as `meta["surface"]`. Because the platform handler delegates accept/close to `AdminHandler.accept`/`AdminHandler.close` on the SAME gin context, those audit rows (written into the target conversation's own tenant trail) carry `meta.surface="platform"`; tenant-scoped `StaffAuth` calls carry no `surface` key.

**Context (already verified in the codebase):**
- `PlatformStaff` lives in `middleware.go` and already sets `CtxUserID`. The platform surface is wired in `cmd/server/main.go` (`platformInbox.Use(auth.PlatformStaff(cfg.InternalAuthSecret))`) and `internal/conversation/platform_handler.go` (`withScope` → `h.admin.accept`/`h.admin.close`).
- `emitAudit` is `admin_handler.go:37-60`; `AuditEvent.Meta` is `bson.M` (`audit.go:57`). Only `accept` (`meta={"path":"manual"}`), `close`/`reopen` (`meta=nil`), and `acceptNext` go through `emitAudit`; of these the platform surface exposes `accept` and `close`.

- [ ] **Step 1: Add the surface context key** in `services/otto/internal/auth/middleware.go`. Replace the const block tail:

```go
	CtxUserRole     = "user_role"
	CtxSessionToken = "session_token"
)
```

with:

```go
	CtxUserRole     = "user_role"
	CtxSessionToken = "session_token"
	// CtxSurface marks which auth surface admitted the request. Only the
	// cross-tenant platform inbox sets it (to "platform"); the tenant-scoped
	// StaffAuth path leaves it empty. emitAudit folds it into the audit
	// event's Meta so platform-surface actions are distinguishable in
	// per-tenant audit trails.
	CtxSurface = "surface"
)

// SurfacePlatform is the CtxSurface value set by PlatformStaff.
const SurfacePlatform = "platform"
```

- [ ] **Step 2: Set the marker in `PlatformStaff`** (same file). Replace:

```go
		c.Set(CtxUserID, userID)
		if email := c.GetHeader("X-User-Email"); email != "" {
```

with:

```go
		c.Set(CtxUserID, userID)
		// Mark this as a platform-surface request so audit entries written
		// into the target conversation's tenant trail record that the action
		// came from the cross-tenant inbox, not the tenant's own staff.
		c.Set(CtxSurface, SurfacePlatform)
		if email := c.GetHeader("X-User-Email"); email != "" {
```

- [ ] **Step 3: Fold the marker into `emitAudit`** in `services/otto/internal/conversation/admin_handler.go`. Replace:

```go
	if meta != nil {
		ev.Meta = bson.M(meta)
	}
	if err := h.d.Audit.Emit(c.Request.Context(), ev); err != nil {
```

with:

```go
	// Platform-surface actions (cross-tenant inbox) are folded into the
	// tenant's audit trail with a marker so they are distinguishable from
	// the tenant's own staff actions. StaffAuth leaves CtxSurface empty.
	if surface := c.GetString(auth.CtxSurface); surface != "" {
		if meta == nil {
			meta = map[string]any{}
		}
		meta["surface"] = surface
	}
	if meta != nil {
		ev.Meta = bson.M(meta)
	}
	if err := h.d.Audit.Emit(c.Request.Context(), ev); err != nil {
```

- [ ] **Step 4: Add the tests** in `services/otto/internal/auth/middleware_test.go`. Insert before the `// Regression: PlatformAuth (stats endpoint) also denies on empty secret.` comment:

```go
// PlatformStaff marks the request with the platform surface so emitAudit
// can distinguish cross-tenant actions in a tenant's audit trail.
func TestPlatformStaffSetsSurfaceMarker(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/p")
	g.Use(PlatformStaff(testSecret))
	g.GET("/ok", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"surface": c.GetString(CtxSurface)})
	})
	w := doReq(r, map[string]string{
		"X-Internal-Auth": testSecret,
		"X-User-Id":       "admin-1",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"surface":"platform"`) {
		t.Fatalf("body %s missing surface=platform", w.Body.String())
	}
}

// StaffAuth (tenant-scoped surface) must NOT set the surface marker, so
// tenant staff actions are not mislabelled as platform actions.
func TestStaffAuthDoesNotSetSurfaceMarker(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/a")
	g.Use(StaffAuth(testSecret))
	g.GET("/ok", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"surface": c.GetString(CtxSurface)})
	})
	req := httptest.NewRequest(http.MethodGet, "/a/ok", nil)
	req.Header.Set("X-Internal-Auth", testSecret)
	req.Header.Set("X-User-Id", "u1")
	req.Header.Set("X-Tenant-Id", "homechef")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"surface":""`) {
		t.Fatalf("body %s should have empty surface", w.Body.String())
	}
}
```

(The test file already imports `net/http`, `net/http/httptest`, `strings`, `testing`, and gin — no import changes needed. `doReq` and `testSecret` already exist.)

- [ ] **Step 5: Verify.** (These exact edits were applied during planning, compiled, tested green, and reverted — the plan is validated to build.)

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/slm-support-platform/services/otto
go build ./... && go vet ./... && go test ./...
```

Expected: `go build`/`go vet` print nothing; `go test ./...` shows `ok` for `internal/auth` and `internal/conversation` (plus the other packages), no `FAIL`.

**Commit (do NOT commit until Ship task):** message `feat(otto): mark platform-surface actions in tenant audit trails`.

---

### Task 2: Hardened platform proxy route (Repo B — tesserix-home)

**Files:**
- Create: `apps/web/app/api/admin/otto/[...path]/route.ts`

**Interfaces:**
- Consumes: `getCurrentSession()` from `@/lib/auth/session-jwt` (cookie OR bearer). Produces: a same-origin proxy at `/api/admin/otto/*` → `${OTTO_URL}/api/v1/platform/otto/*` injecting `X-Internal-Auth` + `X-User-Id/Email/Name`.
- Error contract (identical to the storefront otto proxy): 401 no admin session; 503 if `OTTO_INTERNAL_AUTH` unset; 400 bad path; 413 body over cap; 502 upstream 5xx/failure (body suppressed); 2xx/4xx passed through.

**Context (verified):**
- `apps/web/middleware.ts` already gates `/api/admin/*` (not in `PUBLIC_PATHS`) and accepts cookie OR bearer — so this route is double-gated. `getCurrentSession()` (session-jwt.ts:103) reads the `tx_session` cookie first, then falls back to the `Authorization: Bearer` token; both are the same JWE. This is exactly what `app/api/admin/analytics/support/route.ts` uses.
- Do NOT forward tenant/store headers (platform surface is cross-tenant; otto's `PlatformHandler.withScope` injects the row's real tenant/store) and do NOT forward the `otto_session` customer cookie (this is a staff surface).

- [ ] **Step 1: Create `apps/web/app/api/admin/otto/[...path]/route.ts`** with the complete content:

```ts
// Server-side proxy for the CROSS-TENANT otto platform inbox. The browser
// (tesserix-home admin) and the Expo mobile admin app both call this
// same-origin /api/admin/otto/* route; it adds the X-Internal-Auth shared
// secret and forwards the admin's staff identity so otto can attribute
// accept/reply/close. Targets otto's /api/v1/platform/otto/* surface — the
// unified queue across every product tenant.
//
// Mirrors the hardening of the storefront /api/otto proxy (path-traversal
// guard, host/prefix pinning, 64KB body cap, 10s timeout, 5xx suppression)
// but swaps the anonymous storefront gate for a mandatory admin session and
// points at the platform (not storefront) upstream prefix. No tenant/store
// headers and no otto_session cookie — this is a staff surface, and every
// platform write is re-scoped to the row's own tenant inside otto.
import { type NextRequest, NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth/session-jwt";

const OTTO_URL = (process.env.OTTO_URL ?? "http://localhost:8089").replace(/\/+$/, "");
const OTTO_INTERNAL_AUTH = (process.env.OTTO_INTERNAL_AUTH ?? "").trim();

// Security limits — identical contract to the storefront otto proxy.
const MAX_BODY_BYTES = 64 * 1024; // reject request bodies over 64KB
const UPSTREAM_TIMEOUT_MS = 10_000; // abort the upstream fetch after 10s
const UPSTREAM_PREFIX = `${OTTO_URL}/api/v1/platform/otto/`;
const OTTO_ORIGIN = new URL(OTTO_URL).origin;

// Reject path segments that could break out of the platform/otto prefix.
// Next.js has already URL-decoded these segments, so this check is decode-safe
// (e.g. "%2e%2e" arrives here as ".."). encodeURIComponent does NOT encode ".",
// so without this guard a ".." segment could traverse up to another otto
// surface with the internal secret attached.
function isUnsafeSegment(seg: string): boolean {
  return (
    seg === "" ||
    seg === "." ||
    seg === ".." ||
    seg.includes("/") ||
    seg.includes("\\")
  );
}

async function forward(request: NextRequest, pathSegments: string[]): Promise<Response> {
  // Admin-only: the platform inbox reads/writes across every tenant, so it
  // must never fall open. getCurrentSession() accepts BOTH the tx_session
  // cookie (web) and an Authorization: Bearer session (mobile admin), so one
  // gate covers both clients — the same helper the other /api/admin/* routes use.
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!OTTO_INTERNAL_AUTH) {
    return NextResponse.json(
      { error: "not_configured", message: "OTTO_INTERNAL_AUTH unset" },
      { status: 503 },
    );
  }

  // Path-traversal guard — keep the caller pinned to the platform/otto surface.
  if (pathSegments.length === 0 || pathSegments.some(isUnsafeSegment)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const path = pathSegments.map(encodeURIComponent).join("/");
  const search = request.nextUrl.searchParams.toString();
  const upstream = `${OTTO_URL}/api/v1/platform/otto/${path}${search ? "?" + search : ""}`;

  // Defense-in-depth: the constructed URL must stay host-pinned to OTTO_URL and
  // remain under the intended prefix — reject anything that escaped the guard.
  let parsedUpstream: URL;
  try {
    parsedUpstream = new URL(upstream);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (parsedUpstream.origin !== OTTO_ORIGIN || !upstream.startsWith(UPSTREAM_PREFIX)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Auth": OTTO_INTERNAL_AUTH,
    // Staff identity — otto's PlatformStaff gate requires X-User-Id and
    // attributes accept/reply/close to this admin.
    "X-User-Id": session.sub,
  };
  if (session.email) headers["X-User-Email"] = session.email;
  if (session.name) headers["X-User-Name"] = session.name;

  const method = request.method;
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    // Reject oversized bodies before buffering/forwarding (resource exhaustion).
    const declaredLen = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
  }

  try {
    const res = await fetch(upstream, {
      method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status >= 500) {
      // 5xx bodies can leak internal host/IP/stack — never relay them.
      console.error(`[otto-platform-proxy] upstream ${res.status} for ${parsedUpstream.pathname}`);
      return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    }
    // 2xx and 4xx pass through: 4xx are business errors the inbox needs to render.
    const text = await res.text();
    const out = new NextResponse(text, { status: res.status });
    out.headers.set("Content-Type", res.headers.get("Content-Type") || "application/json");
    return out;
  } catch (err) {
    console.error("[otto-platform-proxy] upstream request failed:", err);
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
```

- [ ] **Step 2: Verify** (after the dependency install in Task 3 — the app must be installed to typecheck):

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/tesserix-home
pnpm --filter web typecheck
```

Expected: no errors referencing `app/api/admin/otto/[...path]/route.ts`.

---

### Task 3: Live-chat page, sidebar link, bubble removal, widget bump (Repo B — tesserix-home)

**Files:**
- Create: `apps/web/components/admin/support/PlatformLiveChatInbox.tsx`
- Create: `apps/web/app/admin/support/live-chat/page.tsx`
- Modify: `apps/web/components/admin/sidebar.tsx`
- Modify: `apps/web/app/admin/layout.tsx`
- Modify: `apps/web/package.json`
- Regenerate: `pnpm-lock.yaml`

**Interfaces:**
- `PlatformLiveChatInbox({ currentUserId }: { currentUserId: string })` — client wrapper mounting `OttoInbox` in platform mode (`apiBaseUrl="/api/admin/otto"`, platform WS URL builders, `tenantLabels`, host toaster bridge via `useToast`).
- `LiveChatPage` — async server component; reads `getCurrentSession()` and passes `session?.sub ?? ""` as `currentUserId` (guaranteeing it equals the `X-User-Id` the proxy forwards, i.e. otto's `assignee.user_id`, so "mine vs theirs" detection is correct).

**Ticket escalation v1 decision (decision 3) — smallest honest version, with the limitation documented:**
The spec assumes staff can create a ticket pre-filled from the selected conversation. The codebase blocks the clean version on TWO independent, out-of-Phase-3 constraints:
1. `OttoInbox@0.6.0` exposes **no** selected-conversation state and **no** action slot (verified against `OttoInboxProps`), so the page cannot read which thread is open. Adding a prop is a design-system release (explicitly out of scope: "do NOT modify the widget in this phase").
2. tesserix-home's tickets are **product-submitted only**: creation is `POST /api/internal/platform-tickets` (bearer-gated, product→platform); there is **no admin-facing create route or form**. Worse, `platform_tickets.tenant_id` is a strict **UUID** column (`createPlatformTicket` casts `$2::uuid`; `createSchema` enforces a UUID regex), but otto's product tenants are string slugs (`homechef`, `fanzone`, `platform`, …). A ticket created from any non-mark8ly chat would fail the `::uuid` cast — so a wired create form would be broken for exactly the products this inbox exists to serve.

**Chosen v1:** a visible **"Create support ticket"** action in a header bar above the inbox that links to the existing tickets console (`/admin/platform-tickets`), where staff file/track tickets. Staff have the conversation open in the adjacent pane (customer, product badge, case id `CS-…`, transcript) to copy context. This ships a real escalation entry point, breaks nothing, and touches no ticket-schema. **Deferred to Phase 4** (batched with the mobile inbox): true one-click prefilled escalation, which needs (a) an `OttoInbox` prop exposing the selected conversation and (b) a tickets tenant model that accepts product-slug tenants (a tesserix-k8s schema change + product decision) plus an admin create route. This limitation is called out inline in the page comment.

- [ ] **Step 1: Bump the widget** in `apps/web/package.json`. Change:

```json
    "@tesserix/otto-widget": "^0.5.1",
```

to:

```json
    "@tesserix/otto-widget": "^0.6.0",
```

- [ ] **Step 2: Regenerate the lockfile.** The `@tesserix` scope resolves from GitHub Packages; supply the token via env (the repo `.npmrc` carries no scoped-registry line, so the scope mapping comes from the environment this token command assumes). Run exactly:

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/tesserix-home
NODE_AUTH_TOKEN=$(gcloud secrets versions access latest --secret=prod-ghcr-token --project=tesseracthub-480811) pnpm install
```

Expected: `pnpm-lock.yaml` now shows `@tesserix/otto-widget@0.6.0` (grep to confirm: `grep -n "otto-widget@0.6.0" pnpm-lock.yaml`). Both `package.json` and `pnpm-lock.yaml` must be committed together.

- [ ] **Step 3: Create the platform-mode wrapper** `apps/web/components/admin/support/PlatformLiveChatInbox.tsx`:

```tsx
"use client";

import { useCallback } from "react";
import { OttoInbox } from "@tesserix/otto-widget";
import { useToast } from "@tesserix/web";

import "@tesserix/otto-widget/styles/inbox.css";

// Cross-tenant "platform mode" inbox for Tesserix support staff. Points the
// widget at the /api/admin/otto platform proxy and the platform WS routes,
// and passes tenantLabels — its PRESENCE switches OttoInbox into platform
// mode (product badge per row + tenant filter chips). Conversations already
// carry tenant_id on the wire, so no backend shape change is needed.
interface PlatformLiveChatInboxProps {
  currentUserId: string;
}

// id -> friendly product name. Any tenant id not in this map falls back to
// its raw id in the badge, so a new product's chats still show (unlabeled)
// until this map is extended. Sourced from every product's OttoWidget
// tenantId across the repos (platform, homechef, fanzone, mark8ly, horoscope,
// stockpilot, scrapper, gameverse, mp-customer).
const TENANT_LABELS: Record<string, string> = {
  platform: "Tesserix",
  homechef: "HomeChef",
  fanzone: "FanZone",
  mark8ly: "mark8ly",
  horoscope: "Horoscope",
  stockpilot: "StockPilot",
  scrapper: "Social Scraper",
  gameverse: "GameVerse",
  "mp-customer": "Marketplace",
};

export function PlatformLiveChatInbox({ currentUserId }: PlatformLiveChatInboxProps) {
  const { toast } = useToast();
  const handleToast = useCallback(
    (tone: "success" | "error" | "info", title: string, description?: string) => {
      toast({
        title,
        description,
        variant:
          tone === "error" ? "destructive" : tone === "success" ? "success" : "default",
      });
    },
    [toast],
  );
  return (
    <OttoInbox
      apiBaseUrl="/api/admin/otto"
      buildInboxWsUrl={buildInboxWsUrl}
      buildConversationWsUrl={buildConversationWsUrl}
      currentUserId={currentUserId}
      onToast={handleToast}
      tenantLabels={TENANT_LABELS}
    />
  );
}

// WS bypasses the Next.js proxy — Istio routes /api/v1/platform/otto/*/ws
// straight to otto (see tesserix-k8s company VirtualService).
function buildInboxWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/platform/otto/ws`;
}

function buildConversationWsUrl(id: string): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/v1/platform/otto/conversations/${encodeURIComponent(id)}/ws`;
}
```

Note: `useToast` in tesserix-home's `@tesserix/web` is the shadcn shape (`toast({ title, description, variant })` with `"success"`/`"destructive"`/`"default"` variants — verified against `apps/web/app/admin/settings/page.tsx`).

- [ ] **Step 4: Create the page** `apps/web/app/admin/support/live-chat/page.tsx` (server component — mirrors mark8ly's server-page pattern so `currentUserId` is the exact id the proxy forwards):

```tsx
import Link from "next/link";
import { MessageSquare, Ticket } from "lucide-react";
import { Button } from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { PlatformLiveChatInbox } from "@/components/admin/support/PlatformLiveChatInbox";

// Platform support inbox — Tesserix staff answer customer chats from EVERY
// product (homechef, fanzone, platform, …) in one queue. The customer-side
// bubble was removed from the admin layout (spec decision 2): admin is a
// staff-side surface only.
//
// Ticket escalation (spec decision 3) is a v1 affordance: OttoInbox@0.6.0
// exposes no selected-conversation state and the tickets system has no
// admin create route (creation is product-side, /api/internal, and
// platform_tickets.tenant_id is a UUID column incompatible with otto's
// product-slug tenants). So the "Create support ticket" button links to the
// tickets console; staff copy context from the open thread. True one-click
// prefilled escalation is deferred to Phase 4 (needs a widget selection prop
// + a tickets tenant-model change).
export default async function LiveChatPage() {
  const session = await getCurrentSession().catch(() => null);
  return (
    <div className="flex h-full flex-col">
      <AdminHeader
        title="Live chat"
        description="Real-time support conversations across every Tesserix product."
        icon={MessageSquare}
      />
      <div className="flex items-center justify-end border-b border-border px-6 py-3">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/platform-tickets">
            <Ticket className="mr-2 h-4 w-4" />
            Create support ticket
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-6">
        <PlatformLiveChatInbox currentUserId={session?.sub ?? ""} />
      </div>
    </div>
  );
}
```

Note: `AdminHeader` accepts `title`, `description?`, `icon?` (verified `apps/web/components/admin/header.tsx`); it has no right-side action slot, hence the separate escalation bar. `Button` supports `asChild` (verified `apps/web/app/not-found.tsx`).

- [ ] **Step 5: Add the sidebar link** in `apps/web/components/admin/sidebar.tsx`. `MessageSquare` is already imported (line 39) — no import change. Insert after the "Support analytics" entry. Replace:

```tsx
  { name: "Support analytics", href: "/admin/analytics/support", icon: BarChart3 },
  { name: "Announcements", href: "/admin/platform-announcements", icon: Megaphone },
```

with:

```tsx
  { name: "Support analytics", href: "/admin/analytics/support", icon: BarChart3 },
  { name: "Live chat", href: "/admin/support/live-chat", icon: MessageSquare },
  { name: "Announcements", href: "/admin/platform-announcements", icon: Megaphone },
```

- [ ] **Step 6: Remove the customer-side chat bubble from the admin layout** (spec decision 2). In `apps/web/app/admin/layout.tsx`:

  (a) Remove the import line:

```tsx
import { OttoSupportChat } from "@/components/OttoSupportChat";
```

  (b) Remove the `AdminSupportChat` wrapper (the comment block + function):

```tsx
// Admin-only support chat — public pages deliberately have no chat widget
// (visitors use /contact). Lives inside AuthGuard so it renders only for
// authenticated staff, with identity from the auth context so the widget
// skips the OTP step.
function AdminSupportChat() {
  const { user } = useAuth();
  return (
    <OttoSupportChat
      userEmail={user?.email ?? undefined}
      userName={user?.displayName ?? user?.name ?? undefined}
    />
  );
}
```

  (c) Remove its mount from the JSX. Replace:

```tsx
                  <div id="main-content" className="lg:pl-72">
                    {children}
                  </div>
                  <AdminSupportChat />
                </div>
```

with:

```tsx
                  <div id="main-content" className="lg:pl-72">
                    {children}
                  </div>
                </div>
```

  `useAuth` stays imported (still used by `AuthGuard`). The component file `apps/web/components/OttoSupportChat.tsx` and the `/api/otto` storefront proxy are LEFT IN PLACE (spec decision 2 keeps the widget available; it is simply no longer mounted in admin). It is not used on any public page today (the admin-only comment confirmed this), so it renders nowhere after this change — that is expected and intended.

- [ ] **Step 7: Verify.** From the repo root:

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/tesserix-home
pnpm --filter web lint
pnpm --filter web typecheck
pnpm --filter web build
```

Expected: lint passes with `--max-warnings 0`; `tsc --noEmit` clean; `next build` completes (this is the same build CI runs inside the Dockerfile on `main`, so a green build here predicts green CI). If `next build` reports the new route/page, that confirms wiring.

**Commit (do NOT commit until Ship task):** message `feat(admin): platform Otto support inbox (proxy + live-chat page)`.

---

### Task 4: Istio VirtualService route for the platform WS (Repo C — tesserix-k8s)

**Files:**
- Modify: `charts/apps/company/templates/virtualservice.yaml`

**Interfaces:**
- Adds one `http` match on the tesserix-home host (`company.tesserix.app`) routing `^/api/v1/platform/otto/(ws|conversations/[^/]+/ws)$` → `support-platform-otto.support-platform.svc.cluster.local:8089` with a 3600s timeout, placed BEFORE the default catch-all. Cross-namespace (`company` runs in `tesserix` ns → `support-platform` ns) works with the mesh's `.svc.cluster.local` DNS — the same chart already routes the storefront otto WS cross-namespace this way, so no `ServiceEntry` or extra config is needed.

**Context (verified):** the `company` chart serves tesserix-home; its VirtualService already contains a storefront otto WS route (`^/api/v1/storefront/otto/conversations/[^/]+/(ws|sse)$` → same otto service:8089, `timeout: 3600s`) immediately before the default route. The otto Service is `support-platform-otto` in ns `support-platform`, port `8089` (`charts/apps/support-platform-otto/values.yaml`). REST platform calls go through the app's `/api/admin/otto` proxy (Task 2), so only the realtime path needs this direct route.

- [ ] **Step 1: Add the route.** In `charts/apps/company/templates/virtualservice.yaml`, replace:

```yaml
      timeout: 3600s

    # Default route to company frontend
    - route:
```

with:

```yaml
      timeout: 3600s

    # Otto PLATFORM inbox realtime — the cross-tenant staff inbox WS and the
    # per-thread WS leave the Next.js admin app and connect straight to the
    # shared otto in support-platform, with a long timeout for the long-lived
    # stream. Covers both /api/v1/platform/otto/ws (inbox) and
    # /api/v1/platform/otto/conversations/<id>/ws (thread). REST platform
    # calls go through the app's /api/admin/otto proxy (which injects the
    # internal-auth secret + staff identity), so only the realtime path needs
    # this direct route. Must precede the catch-all.
    - match:
        - uri:
            regex: ^/api/v1/platform/otto/(ws|conversations/[^/]+/ws)$
      route:
        - destination:
            host: support-platform-otto.support-platform.svc.cluster.local
            port:
              number: 8089
      timeout: 3600s

    # Default route to company frontend
    - route:
```

- [ ] **Step 2: Verify the chart renders** (read-only templating, allowed):

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/tesserix-k8s
helm template company charts/apps/company -s templates/virtualservice.yaml | grep -A6 "platform/otto"
```

Expected: the rendered `regex: ^/api/v1/platform/otto/(ws|conversations/[^/]+/ws)$` block appears BEFORE the final default `- route:` and points at `support-platform-otto.support-platform.svc.cluster.local` port `8089`. (If `-s` path errors, run without `-s` and grep the same.)

**Commit (do NOT commit until Ship task):** message `feat(company): route platform Otto inbox WS to support-platform-otto`.

---

### Task 5: Ship — commit, deploy, verify (all three repos)

Rollout order (each step is independently shippable; the inbox shows an empty state until the backend and VS are live): **Task 1 (otto) → Task 4 (VS) → Tasks 2-3 (tesserix-home web).** The audit marker (Task 1) must land before Phase 3 goes live (post-review follow-up); the VS (Task 4) before the web page so WebSockets connect.

**Preconditions for every repo:** set the personal git identity, and confirm NO AI/Claude/Co-Authored-By text anywhere in the diff.

```bash
git config user.name "sam123ben"
git config user.email "samyak.rout@gmail.com"
git config user.email   # must print samyak.rout@gmail.com
```

- [ ] **Step 1: Ship Repo A — slm-support-platform (PRIVATE → public→build→private cycle).**

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/slm-support-platform
git config user.name "sam123ben" && git config user.email "samyak.rout@gmail.com"
git checkout -b feat/otto-audit-surface-marker
git add services/otto/internal/auth/middleware.go \
        services/otto/internal/auth/middleware_test.go \
        services/otto/internal/conversation/admin_handler.go
git commit -m "feat(otto): mark platform-surface actions in tenant audit trails"

# Private repo → make public, push/merge to main to trigger CI, wait green, make private.
gh repo edit tesserix/slm-support-platform --visibility public --accept-visibility-change-consequences
git push -u origin feat/otto-audit-surface-marker
gh pr create --repo tesserix/slm-support-platform --base main --head feat/otto-audit-surface-marker \
  --title "feat(otto): mark platform-surface actions in tenant audit trails" \
  --body "Adds a surface=platform marker to audit Meta so cross-tenant platform inbox actions are distinguishable in per-tenant audit trails. Phase-1 review follow-up, required before Phase 3 goes live."
gh pr merge --repo tesserix/slm-support-platform --squash --admin   # merges to main, triggers ci-otto build+push

# Watch CI (ci-otto builds+pushes the otto image), then re-privatize once green.
gh run list --repo tesserix/slm-support-platform --limit 5
gh run watch <run-id> --repo tesserix/slm-support-platform
gh repo edit tesserix/slm-support-platform --visibility private --accept-visibility-change-consequences

# Read-only deploy watch (otto rolls out via its existing image promotion / ArgoCD).
kubectl get deploy -n support-platform
kubectl rollout status deploy/support-platform-otto -n support-platform
```

- [ ] **Step 2: Ship Repo C — tesserix-k8s (direct to main, ArgoCD auto-sync).**

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/tesserix-k8s
git config user.name "sam123ben" && git config user.email "samyak.rout@gmail.com"
git checkout -b feat/otto-platform-inbox-vs
git add charts/apps/company/templates/virtualservice.yaml
git commit -m "feat(company): route platform Otto inbox WS to support-platform-otto"
git push -u origin feat/otto-platform-inbox-vs
gh pr create --repo tesserix/tesserix-k8s --base main --head feat/otto-platform-inbox-vs \
  --title "feat(company): route platform Otto inbox WS to support-platform-otto" \
  --body "Adds the /api/v1/platform/otto/*/ws route on the tesserix-home host, mirroring the existing storefront otto WS route. ArgoCD auto-syncs the company Application."
gh pr merge --repo tesserix/tesserix-k8s --squash --admin

# ArgoCD auto-syncs the company app. Read-only verify:
kubectl get vs -n tesserix | grep -i company
kubectl get vs -n tesserix -o yaml <company-vs-name> | grep -A6 "platform/otto"
```

(If tesserix-k8s convention is direct-to-main, replace the PR block with `git push origin HEAD:main`.)

- [ ] **Step 3: Ship Repo B — tesserix-home (PUBLIC → no visibility cycle).**

```bash
cd /Users/samyakrout/Desktop/samyak-work/projects/new-repos/tesserix-home
git config user.name "sam123ben" && git config user.email "samyak.rout@gmail.com"
gh repo view tesserix/tesserix-home --json visibility   # confirm PUBLIC (no cycle needed)
git checkout -b feat/otto-platform-inbox-ui
git add apps/web/app/api/admin/otto/ \
        apps/web/components/admin/support/PlatformLiveChatInbox.tsx \
        apps/web/app/admin/support/live-chat/page.tsx \
        apps/web/components/admin/sidebar.tsx \
        apps/web/app/admin/layout.tsx \
        apps/web/package.json pnpm-lock.yaml
git commit -m "feat(admin): platform Otto support inbox (proxy + live-chat page)"
git push -u origin feat/otto-platform-inbox-ui
gh pr create --repo tesserix/tesserix-home --base main --head feat/otto-platform-inbox-ui \
  --title "feat(admin): platform Otto support inbox (proxy + live-chat page)" \
  --body "Cross-tenant Otto inbox in tesserix-home admin: hardened /api/admin/otto platform proxy, /admin/support/live-chat page (OttoInbox platform mode 0.6.0), sidebar link, removal of the customer-side chat bubble from admin, and a v1 'Create support ticket' escalation link."
gh pr merge --repo tesserix/tesserix-home --squash --admin   # to main → ci.yml builds image → Kargo promotes → ArgoCD syncs company

# Watch CI + rollout (company Deployment runs in the tesserix ns):
gh run list --repo tesserix/tesserix-home --limit 5
gh run watch <run-id> --repo tesserix/tesserix-home
kubectl get deploy -n tesserix | grep -i company
kubectl rollout status deploy/<company-deploy-name> -n tesserix
```

- [ ] **Step 4: Post-deploy smoke** (manual, read-only): open `https://company.tesserix.app/admin/support/live-chat`, confirm the inbox loads, product badges + tenant-filter chips render (platform mode), a chat opened from a product surfaces in the queue, and accept/reply/close work with live WS updates. Regression-check mark8ly admin's own live-chat (single-tenant, unchanged). Confirm the customer-side bubble no longer appears anywhere in tesserix-home admin.

---

## Notes / risks

- **Widget already published.** `@tesserix/otto-widget@0.6.0` is live in GitHub Packages (design-system) with platform mode; Phase 3 only consumes it. No design-system work.
- **Mobile write path (Phase 4).** The proxy already accepts the mobile bearer (via `getCurrentSession()`), but mobile POSTs also need the middleware's bearer-CSRF exemption (the `evaluateCsrf`/`bearerToken` work already imported in `middleware.ts`). Web (cookie) is unaffected. Phase 4 (native screens) is out of this plan.
- **Ticket escalation is a documented v1** (link-only) — see Task 3's decision block. Do not silently expand it into a broken create form.
- **Cross-namespace WS** relies on the mesh allowing `tesserix` → `support-platform`; proven by the existing storefront otto route on the same host. If an AuthorizationPolicy later restricts `support-platform`, the platform WS route must be added to its allow-list (out of current scope).
</content>
</invoke>
