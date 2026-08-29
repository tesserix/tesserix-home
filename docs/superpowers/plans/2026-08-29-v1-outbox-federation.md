# V1 — Outbox Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mark8ly's `GET /admin/outbox` reachable from the console — a platform-api module, a console reader, a console page — so an operator can see undelivered and failed outbox events without opening a database.

**Architecture:** Three layers plus one config change. A generic platform-api module federates the contract's `outbox` endpoint across every product declaring it (`SlugsImplementing("outbox")`), mirroring the `audit` module exactly. The console reads that through `lib/outbox.ts` and renders `/platform/outbox`. The config change is load-bearing and easy to miss: platform-api learns which endpoints a product implements from an **environment variable**, not from the product's `admin-conformance.json`.

**Tech Stack:** Go 1.26 (platform-api, stdlib `net/http` + the repo's `httpx`/`auth`/`federation` kernel); Next.js 16 + React 19 + TypeScript (apps/console); Helm (tesserix-k8s); pnpm.

**Spec:** `docs/superpowers/specs/2026-08-29-admin-contract-v3-console-federation-design.md` — §4 (federation), §5 (console), §7 (V1 is the first vertical, and every later vertical is a variation on it).

## Global Constraints

- **`FEDERATION_MARK8LY_ENDPOINTS` does not exist today.** Verified against the running deployment: `FEDERATION_PRODUCTS = kora,mark8ly`, `FEDERATION_KORA_ENDPOINTS = inbox`, and mark8ly has **no** `_ENDPOINTS` var at all. `registry.go:136-200` reads `Endpoints` from `FEDERATION_<SLUG>_ENDPOINTS`; declaring `outbox` in mark8ly's `admin-conformance.json` does **not** feed this. Without the env var, `SlugsImplementing("outbox")` returns an empty list and the page renders "no rows" — indistinguishable from a healthy empty outbox. Task 4 is not optional.
- **`SlugsImplementing`, never `Slugs`.** `Slugs()` means the endpoint is universal and a product without one should answer 501. An outbox is not universal. `registry.go:112` is the helper; `tenants`' comment in `cmd/server/main.go` explains the distinction.
- **`apps/console/lib/triage.ts`'s outbox is a DIFFERENT SURFACE.** It parses `{summaries[], recent[]}` — estate-wide async-delivery health across databases, read from `apps/web`, feeding the dashboard's triage signals. mark8ly's `/admin/outbox` is one product's transactional outbox with an entirely different row shape. **Do not merge them, do not rewire either into the other, do not "unify" the types.** This is the same trap the design's §1.1 records for notifications.
- **`error` is an opaque string.** `outbox.go:66-73`: the column has no CHECK constraint and the operator requeue path is a raw `UPDATE`, so the codes this service writes are not the only values observable. Render with an unknown-value fallback, **never a `switch`** that assumes a closed set.
- **`age_seconds` is absent for published rows, by design.** `outbox.go:75-78`: a settled row has no waiting time, and a number that grew forever there would read as "stuck" beside a genuinely stuck row. Render absence as absence — not `0`, not a computed age.
- **No `payload` field exists and none may be added.** Excluded by construction upstream because it is arbitrary JSONB that may carry customer data.
- **Import `PlatformApiError` from `./platform-api-error`, never from `./platform-api`.** It is a value (thrown, narrowed with `instanceof`), and a value import from `./platform-api` drags `pg` into the browser bundle and breaks the production build. `lib/audit.ts:1-7` carries this warning from having been bitten.
- **`pnpm lint` and `next build` are both required gates.** `tsc` and `vitest` cannot see server-only code reaching the browser bundle, and a missed `pnpm lint` already broke CI once in this workstream.
- Console is pnpm with hoisted `node_modules` — all deps live at the repo root.

---

### Task 1: The platform-api outbox module

**Files:**
- Create: `platform-api/internal/modules/outbox/outbox.go` (the module's entire public surface: `Config` + `Register`)
- Create: `platform-api/internal/modules/outbox/internal/domain/event.go`
- Create: `platform-api/internal/modules/outbox/internal/service/service.go`
- Create: `platform-api/internal/modules/outbox/internal/handler/handler.go`
- Test: `platform-api/internal/modules/outbox/internal/service/service_test.go`, `.../internal/handler/handler_test.go`

**Interfaces:**
- Consumes: `federation.Client`, `auth.Verifier`, `httpx` — the kernel only. It imports **no other module**.
- Produces: `outbox.Register(mux *http.ServeMux, cfg outbox.Config)` and `outbox.Config{Fed *federation.Client; Slugs []string; Verifier *auth.Verifier; Log *slog.Logger}` — the identical shape `audit.Config` has. Task 2 wires exactly this.

**Read `platform-api/internal/modules/audit/` first, in full.** It federates `/admin/audit-logs`, a `data-pagination` read, across products — structurally the same problem. Mirror its layout, its fan-out, its per-source failure handling, and its package-doc voice. Do not invent a different shape; a second shape for the same job is what makes the fifth module unreviewable.

- [ ] **Step 1: Write the failing service test**

The service fans out to every slug and merges. Model the test on `audit/internal/service/service_test.go` — read it and reuse its fake-federation approach rather than inventing one. It must cover:

```
- two products both returning rows -> merged, and every row carries its source slug
- one product failing -> the other product's rows still return, and the failure is
  reported as a named degraded source rather than failing the whole request
- a product returning 501 -> reported as not-implemented, NOT as an error
- zero slugs configured -> an empty result and no panic (this is the state today,
  before Task 4 sets the env var)
```

The last case is the one that matters most operationally: it is exactly what production looks like until `FEDERATION_MARK8LY_ENDPOINTS` is set, and the console must be able to tell it apart from a genuinely empty outbox.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/platform-api
go test ./internal/modules/outbox/... -v
```

Expected: build failure — the package does not exist yet.

- [ ] **Step 3: Write the domain type**

`domain.Event` mirrors mark8ly's pinned wire shape (`outbox.go:79-90`) exactly, plus the source slug the fan-out adds:

```go
type Event struct {
	ID          string
	TenantID    string
	Aggregate   string
	AggregateID string
	EventType   string
	Status      string
	CreatedAt   string
	// Absent for a published row: it is settled and has no waiting time. A
	// number that grew forever there would read as "stuck" beside a genuinely
	// stuck row, so absence is preserved rather than defaulted to zero.
	AgeSeconds *int64
	PublishedAt *string
	// OPAQUE. `outbox_events.error` has no CHECK constraint and the operator
	// requeue path is a raw UPDATE, so the codes mark8ly writes are not the
	// only values observable here. Never switch on it.
	Error *string
	// Which product produced this row. Required — a merged list from two
	// products whose rows are indistinguishable is not a governance surface.
	Source string
}
```

There is deliberately **no** `Payload` field. It is excluded by construction upstream and must stay excluded here.

- [ ] **Step 4: Write the service and handler**

Follow `audit`'s structure. The handler mounts `GET /v1/outbox`, forwards the query parameters mark8ly accepts — `status`, `event_type`, `older_than_minutes`, `since_hours`, `tenant_id`, `page`, `limit` (`outbox.go:173-201`) — and returns the merged page plus the per-source status the service reports.

`Register` panics on a nil `Log`, with `audit.go:39-47`'s reasoning: the failure path is what writes to it, so a nil logger is a panic that only appears during an outage.

- [ ] **Step 5: Run the tests**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/platform-api
go test ./internal/modules/outbox/... -v
go build ./...
go vet ./...
```

Expected: PASS, clean build, clean vet.

- [ ] **Step 6: Commit**

```bash
git add platform-api/internal/modules/outbox
git commit -m "feat(platform-api): federate the contract's outbox endpoint"
```

---

### Task 2: Wire the module into the server

**Files:**
- Modify: `platform-api/cmd/server/main.go` — add a `httpx.RegisterModule` block beside the existing ones
- Test: `platform-api/cmd/server/` — if a routing test exists there, extend it; otherwise no new test (Task 1 covers the module, and this is wiring)

**Interfaces:**
- Consumes: `outbox.Register` / `outbox.Config` from Task 1.
- Produces: `GET /v1/outbox` mounted on the running server.

- [ ] **Step 1: Add the registration**

Place it beside the other module registrations, matching their form:

```go
	httpx.RegisterModule(mux, verifier, "outbox", func(m *http.ServeMux) {
		outbox.Register(m, outbox.Config{
			Fed: fed,
			// SlugsImplementing, not Slugs: an outbox is not universal. A
			// product without one has no outbox, and asking it would 404 and
			// surface to an operator as a failed source when the honest
			// answer is that the product has none. Same distinction the
			// tenants block draws for SlugsServing.
			Slugs:    cfg.Federation.SlugsImplementing("outbox"),
			Verifier: verifier,
			Log:      log,
		})
	})
```

- [ ] **Step 2: Build and vet**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/platform-api
go build ./... && go vet ./... && go test ./... 2>&1 | tail -20
```

Expected: clean, and the existing suite still passes.

- [ ] **Step 3: Commit**

```bash
git add platform-api/cmd/server/main.go
git commit -m "feat(platform-api): mount the outbox module"
```

---

### Task 3: The console reader and page

**Files:**
- Create: `apps/console/lib/outbox.ts`
- Create: `apps/console/lib/outbox.test.ts`
- Create: `apps/console/app/(console)/platform/outbox/page.tsx`
- Create: `apps/console/app/(console)/platform/outbox/page.test.tsx`
- Modify: `packages/console-core/src/routes.ts` — `platform.outbox`

**Interfaces:**
- Consumes: `GET /v1/outbox` from Task 2.
- Produces: `readOutbox(...)` and an exported row type from `lib/outbox.ts`; a route at `/platform/outbox`.

**Read `apps/console/lib/audit.ts` and `app/(console)/platform/audit-log/page.tsx` first.** They are the closest analogs — a federated, multi-source, paginated list with per-source degradation. Match their conventions.

- [ ] **Step 1: Write the failing reader test**

`apps/console/lib/outbox.test.ts` must cover, at minimum:

```
- a well-formed { data, pagination } response parses into rows, each carrying its source
- a row WITHOUT age_seconds keeps it absent — not 0, not derived from created_at
- a row with an UNRECOGNISED error string parses and is preserved verbatim
- a malformed response throws PlatformApiError rather than yielding a half-built row
- a 501 from the platform API is surfaced as "not federated", distinct from an empty list
```

The last two are the ones that earn their place. The estate has already shipped a bug where an empty render meant "not wired" and read as "nothing to see".

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm --filter console exec vitest run lib/outbox.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `lib/outbox.ts`**

Import `PlatformApiError` from `./platform-api-error` — see Global Constraints; importing it from `./platform-api` breaks the production build.

Validate at the boundary and throw on anything unexpected rather than coercing. Preserve `age_seconds` absence and `error` opacity exactly as Task 1's domain comment describes.

- [ ] **Step 4: Write the page**

`/platform/outbox` renders the merged list: source, event type, aggregate, status, age, and the opaque error. Requirements that are not stylistic:

- **Render `error` with an unknown-value fallback, never a `switch`.** Any string may appear.
- **A row with no `age_seconds` shows no age** — an em dash or similar, not `0s`.
- **Distinguish "not federated" from "empty".** A 501, or zero configured sources, must not render as an empty table that reads like a healthy outbox. Use the surface-state conventions the audit-log page already uses.
- **Name the source on every row.** A merged list whose rows are indistinguishable by product is not a governance surface.

- [ ] **Step 5: Clear the route's `pending`**

In `packages/console-core/src/routes.ts`, `platform.outbox` currently reads:

```ts
  "platform.outbox": { web: "/admin/outbox", mobile: "/platform/outbox", pending: true, capability: "platform" },
```

Add the console path and drop `pending` — the flag means "the console has not kept this promise", and it now has:

```ts
  "platform.outbox": { web: "/admin/outbox", mobile: "/platform/outbox", console: "/platform/outbox", capability: "platform" },
```

Check `routes.test.ts` and `routes.console.test.ts` for assertions about which routes are pending or which have a `console` path, and update them to state the new truth rather than loosening them.

- [ ] **Step 6: Run every gate**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
pnpm --filter console exec vitest run
pnpm --filter console lint
pnpm --filter console exec tsc --noEmit
pnpm --filter console build
```

**All four are required.** Note the `exec` — `pnpm --filter console vitest run` is not a real script and fails; that was wrong in this plan's first revision and corrected after Task 3 hit it. `tsc` and `vitest` cannot see server-only code reaching the browser bundle — only `build` catches that — and a skipped `lint` already broke CI once in this workstream. Paste real output for each.

- [ ] **Step 7: Commit**

```bash
git add apps/console/lib/outbox.ts apps/console/lib/outbox.test.ts \
        "apps/console/app/(console)/platform/outbox" \
        packages/console-core/src/routes.ts
git commit -m "feat(console): surface the federated outbox at /platform/outbox"
```

---

### Task 4: Turn federation on for mark8ly's outbox

**Files:**
- Modify: the tesserix-k8s chart supplying platform-api's environment — find it rather than assuming:

```bash
grep -rn "FEDERATION_KORA_ENDPOINTS" /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s/charts/ | head
```

`FEDERATION_KORA_ENDPOINTS = inbox` is set today and is the pattern to copy.

**Interfaces:**
- Consumes: Task 2's mounted route.
- Produces: `SlugsImplementing("outbox")` returning `["mark8ly"]` in production instead of `[]`.

**This task is what makes the other three visible.** Verified against the running deployment: mark8ly has no `_ENDPOINTS` variable at all, so without this the page renders an empty table that looks exactly like a healthy, empty outbox.

- [ ] **Step 1: Add the variable**

Set `FEDERATION_MARK8LY_ENDPOINTS` to `outbox`, in the same place and form as `FEDERATION_KORA_ENDPOINTS`. Comment that this list is what `registry.go`'s `SlugsImplementing` reads, and that it is **separate from** mark8ly's `admin-conformance.json` — the declaration governs what the conformance suite checks; this variable governs what platform-api will call. Two lists, two purposes, and a reader who assumes one implies the other will be wrong.

- [ ] **Step 2: Bump the chart version**

`ct lint` fails a changed chart whose version did not move — this already cost a CI round in this workstream. Bump the `version:` in that chart's `Chart.yaml`.

- [ ] **Step 3: Render the chart locally**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
helm template <chart-path> | grep -A2 FEDERATION_MARK8LY_ENDPOINTS
```

Expected: the variable is present with value `outbox`. If `helm` is unavailable, say so in the report rather than skipping the verification silently.

- [ ] **Step 4: Commit**

```bash
git add charts/
git commit -m "feat(platform-api): federate mark8ly's outbox endpoint"
```

---

### Task 5: Prove it against the running system

**Files:** none. This task produces evidence.

The gate is a live-system state, not a merge. A merged config change that ArgoCD has not yet synced leaves the surface exactly as broken as before, while every PR looks done.

- [ ] **Step 1: Confirm the env var reached the pod**

```bash
kubectl -n tesserix get deploy platform-api -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="FEDERATION_MARK8LY_ENDPOINTS")].value}'
```

Expected: `outbox`. Empty means ArgoCD has not synced yet — poll the value itself, not the Application's `Synced` status, which can report Synced against an older revision.

- [ ] **Step 2: Confirm the route answers**

Port-forward platform-api and request `/v1/outbox` without credentials. Expect **401** — the route exists and auth rejected it. A **404** means the module is not mounted; a **501** means it is mounted but no product is federated, which points back at Step 1.

`curl` is not installed in this environment; use `python3 -c "import urllib.request; ..."` as the probe.

- [ ] **Step 3: Confirm the page renders real rows**

Load `/platform/outbox` in the console against production data and confirm rows appear with their source named, that a published row shows no age, and that the page does not read as empty.

- [ ] **Step 4: Record the evidence**

Append what you observed — the env value, the probe's status codes, and what the page showed — to the design doc under a `## 11. V1 outbox, verified` heading, dated. The next vertical starts from a known-good foundation rather than an assumption.

---

## What comes after this plan

V2 `email-sends` and V3 `notifications` are the same three layers with a different row shape, and should be written against **this** vertical's merged code rather than guessed at now. V3 additionally must not be wired into the console's notification bell, which is a derived surface with no table behind it (design §1.1).

Two facts this vertical establishes that outlive it:

- Federating a contract endpoint takes **four** changes, not three. The `FEDERATION_<SLUG>_ENDPOINTS` env var is the one with no compiler or test to catch its absence, and its failure mode is a page that looks healthy and empty.
- `SlugsImplementing` vs `Slugs` is the reviewable decision in every future module: universal endpoints answer 501 and should be carried to the console; optional ones should not be asked at all.
