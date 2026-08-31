# secrets-api Zitadel auth — Implementation Plan (phase 1 of the cutover)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `secrets-api` authenticates callers with Zitadel bearer tokens and authorises them by capability, sharing one vocabulary with `platform-api`.

**Architecture:** The Zitadel verifier and capability vocabulary move out of `platform-api/internal/platform/auth` into a new `platform-auth/` module. `platform-api` keeps that import path as a thin alias layer so its 65 importers compile unchanged. `secrets-api` adds a small gin adapter over the shared `Verifier`, swaps its route groups from session-based to capability-based gates, then deletes the cookie stack.

**Tech Stack:** Go 1.26, gin (secrets-api), net/http (platform-api), `github.com/coreos/go-oidc/v3`, Go workspaces (`go.work`).

**Spec:** `docs/superpowers/specs/2026-09-01-secrets-console-cutover-design.md`

This plan covers **steps 1 and 2 of spec §9 only**. Steps 3–6 (console surface, notifications, the chart cutover, retirement) are separate plans. Nothing in this plan deploys: `platform-api` redeploys with a behaviour-neutral change, and `secrets-api`'s image tag is pinned so its merge is held until the chart PR in a later phase.

## Global Constraints

- Go **1.26**. `go.work` already lists `./platform-api` and `./secrets-api`.
- Module paths are `github.com/tesserix/tesserix-home/<dir>`. The new module is `github.com/tesserix/tesserix-home/platform-auth`.
- The capability vocabulary must stay byte-identical in meaning to `packages/platform-auth/src/capabilities.ts`. `capabilities_contract_test.go` enforces this and must keep passing.
- **Never authorise on `Principal.Kind`.** Authorisation is by capability only. `Kind` is for the audit trail.
- Gates follow **effect, not HTTP verb** (spec §4). A route that changes live state needs `rotate-credentials`; a route that only opens a pull request needs `platform`.
- Every test is **mutated before it is trusted**: make it fail, then restore. A test that has only ever passed has demonstrated nothing.
- Commit messages are single-line, conventional-commit prefixed, no signature.

## Correction to the spec

Spec §3 says `internal/platform/reqid` "moves with" the auth package. **It does not.** Verified: `capabilities.go`, `verify.go` and `oidc.go` import only stdlib plus `github.com/coreos/go-oidc/v3`. Only `middleware.go` imports `reqid`.

So `middleware.go` and `middleware_test.go` **stay in `platform-api`** — they are net/http-specific refusal-envelope policy — and `reqid` does not move. This is strictly better than the spec: a smaller shared module and no change to `middleware.go` at all. `secrets-api` is gin, so it could not have reused that middleware regardless.

---

### Task 1: Create the `platform-auth` module

Pure move. No behaviour change, no logic edited.

**Files:**
- Create: `platform-auth/go.mod`
- Move: `platform-api/internal/platform/auth/capabilities.go` → `platform-auth/capabilities.go`
- Move: `platform-api/internal/platform/auth/verify.go` → `platform-auth/verify.go`
- Move: `platform-api/internal/platform/auth/oidc.go` → `platform-auth/oidc.go`
- Move: `platform-api/internal/platform/auth/capabilities_contract_test.go` → `platform-auth/capabilities_contract_test.go`
- Move: `platform-api/internal/platform/auth/verify_test.go` → `platform-auth/verify_test.go`
- Move: `platform-api/internal/platform/auth/oidc_test.go` → `platform-auth/oidc_test.go`
- Modify: `go.work`

**Interfaces:**
- Consumes: nothing.
- Produces: package `auth` at `github.com/tesserix/tesserix-home/platform-auth`, exporting exactly what `platform-api/internal/platform/auth` exported minus `Authenticate`, `RequireCapability` and `FromContext` (which stay behind in `middleware.go`). Specifically: types `Capability`, `Claims`, `Config`, `OIDCParser`, `Option`, `Principal`, `PrincipalKind`, `TokenParser`, `Verifier`; funcs `NewOIDCParser`, `NewVerifier`, `WithConsoleClientID`; vars `Capabilities`, `Surfaces`, `Verbs`, `Machines`, `ErrNotJWT`, `ErrAudience`, `ErrNoRoles`, `ErrExpired`, `ErrInvalid`, `ErrAuthDisabled`; consts `CapRead`, `CapCRM`, `CapSupport`, `CapBilling`, `CapPlatform`, `CapRespond`, `CapRotateCredentials`, `CapAdjustBalance`, `CapExecuteRefund`, `CapMassSend`, `CapHardDelete`, `CapPublishCatalog`, `CapReadPlanCatalog`, `KindOperator`, `KindService`; methods `Config.Validate`, `Principal.Has`, `OIDCParser.Parse`, `Verifier.Verify`.

- [ ] **Step 1: Create the module**

```bash
cd /path/to/tesserix-home
mkdir platform-auth
cd platform-auth
cat > go.mod <<'EOF'
// Package auth is the estate's Zitadel verifier and capability vocabulary.
//
// It lives in its own module rather than inside platform-api because
// secrets-api needs it too, and Go's internal/ rule forbids importing
// platform-api/internal/... from another module root.
module github.com/tesserix/tesserix-home/platform-auth

go 1.26
EOF
```

- [ ] **Step 2: Move the three source files and their tests**

```bash
cd /path/to/tesserix-home
git mv platform-api/internal/platform/auth/capabilities.go platform-auth/capabilities.go
git mv platform-api/internal/platform/auth/verify.go platform-auth/verify.go
git mv platform-api/internal/platform/auth/oidc.go platform-auth/oidc.go
git mv platform-api/internal/platform/auth/capabilities_contract_test.go platform-auth/capabilities_contract_test.go
git mv platform-api/internal/platform/auth/verify_test.go platform-auth/verify_test.go
git mv platform-api/internal/platform/auth/oidc_test.go platform-auth/oidc_test.go
```

Do NOT move `middleware.go` or `middleware_test.go`. They import `reqid` and are net/http-specific.

- [ ] **Step 3: Fix the contract test's path to capabilities.ts**

The test walks up from its own directory. It was four levels deep; it is now one.

In `platform-auth/capabilities_contract_test.go`, change:

```go
	path := filepath.Join("..", "..", "..", "..", "packages", "platform-auth", "src", "capabilities.ts")
```

to:

```go
	path := filepath.Join("..", "packages", "platform-auth", "src", "capabilities.ts")
```

- [ ] **Step 4: Add the module to the workspace**

Edit `go.work` so it reads exactly:

```
go 1.26.5

use ./platform-api
use ./platform-auth
use ./secrets-api
```

- [ ] **Step 5: Resolve the go-oidc dependency**

```bash
cd /path/to/tesserix-home/platform-auth
go mod tidy
```

Expected: `go.mod` gains `require github.com/coreos/go-oidc/v3 vX.Y.Z` and a `go.sum` appears.

- [ ] **Step 6: Run the moved tests and verify the contract test still finds capabilities.ts**

Run: `cd platform-auth && go test ./... -v -run TestCapabilitiesMatchTheTypeScriptVocabulary`
Expected: PASS. If it fails with "reading the TypeScript vocabulary: no such file", Step 3's path is wrong.

- [ ] **Step 7: Run the whole new module's suite**

Run: `cd platform-auth && go test ./...`
Expected: `ok  github.com/tesserix/tesserix-home/platform-auth`

- [ ] **Step 8: Mutate the contract test to prove it still bites**

Temporarily add a bogus capability to `platform-auth/capabilities.go`'s `Capabilities` slice:

```go
var Capabilities = []Capability{
	CapRead,
	Capability("not-a-real-role"),
	CapCRM, CapSupport, CapBilling, CapPlatform,
	CapRespond, CapRotateCredentials, CapAdjustBalance,
	CapExecuteRefund, CapMassSend, CapHardDelete, CapPublishCatalog,
	CapReadPlanCatalog,
}
```

Run: `cd platform-auth && go test ./... -run TestCapabilitiesMatchTheTypeScriptVocabulary`
Expected: FAIL, reporting a capability count difference.

Then revert that edit exactly (`git checkout platform-auth/capabilities.go`) and re-run:
Expected: PASS.

- [ ] **Step 9: Commit**

`platform-api` does not compile at this point — that is Task 2's job. Commit anyway; the two tasks are one logical move and Task 2 follows immediately.

```bash
git add go.work platform-auth/
git add -u platform-api/internal/platform/auth/
git commit -m "refactor(auth): move the Zitadel verifier and capability vocabulary into a platform-auth module"
```

---

### Task 2: Reduce platform-api's auth package to an alias layer

**Files:**
- Create: `platform-api/internal/platform/auth/alias.go`
- Create: `platform-api/internal/platform/auth/alias_test.go`
- Modify: `platform-api/go.mod`
- Unchanged: `platform-api/internal/platform/auth/middleware.go`, `middleware_test.go`

**Interfaces:**
- Consumes: everything Task 1's Produces block lists.
- Produces: the identical exported surface at the old import path `github.com/tesserix/tesserix-home/platform-api/internal/platform/auth`, so all 65 importing files compile with no edit.

- [ ] **Step 1: Add the dependency to platform-api**

```bash
cd /path/to/tesserix-home/platform-api
go mod edit -require=github.com/tesserix/tesserix-home/platform-auth@v0.0.0
```

The workspace resolves this locally; the pseudo-version is never fetched. `go.work` must list both modules (Task 1 Step 4) or this fails at build time.

- [ ] **Step 2: Write the alias file**

Create `platform-api/internal/platform/auth/alias.go`:

```go
// This file is an alias layer, not a second definition.
//
// The Zitadel verifier and the capability vocabulary live in the platform-auth
// module, because secrets-api needs them too and Go's internal/ rule forbids
// importing platform-api/internal/... across module roots.
//
// Everything below is a Go alias or a re-exported value — never a copy. That
// distinction is the point: an alias cannot drift, whereas a copied constant
// can be edited here and silently disagree with Zitadel. alias_test.go asserts
// it stays that way.
//
// middleware.go is deliberately NOT here. It is net/http-specific refusal
// policy that depends on internal/platform/reqid, so it stays in this package.
package auth

import authcore "github.com/tesserix/tesserix-home/platform-auth"

type (
	Capability    = authcore.Capability
	Claims        = authcore.Claims
	Config        = authcore.Config
	OIDCParser    = authcore.OIDCParser
	Option        = authcore.Option
	Principal     = authcore.Principal
	PrincipalKind = authcore.PrincipalKind
	TokenParser   = authcore.TokenParser
	Verifier      = authcore.Verifier
)

const (
	CapRead              = authcore.CapRead
	CapCRM               = authcore.CapCRM
	CapSupport           = authcore.CapSupport
	CapBilling           = authcore.CapBilling
	CapPlatform          = authcore.CapPlatform
	CapRespond           = authcore.CapRespond
	CapRotateCredentials = authcore.CapRotateCredentials
	CapAdjustBalance     = authcore.CapAdjustBalance
	CapExecuteRefund     = authcore.CapExecuteRefund
	CapMassSend          = authcore.CapMassSend
	CapHardDelete        = authcore.CapHardDelete
	CapPublishCatalog    = authcore.CapPublishCatalog
	CapReadPlanCatalog   = authcore.CapReadPlanCatalog

	KindOperator = authcore.KindOperator
	KindService  = authcore.KindService
)

// Slices share their backing array with platform-auth's, so these are the same
// values rather than copies of them.
var (
	Capabilities = authcore.Capabilities
	Surfaces     = authcore.Surfaces
	Verbs        = authcore.Verbs
	Machines     = authcore.Machines
)

// The same error VALUES, so errors.Is across the module boundary works.
var (
	ErrNotJWT       = authcore.ErrNotJWT
	ErrAudience     = authcore.ErrAudience
	ErrNoRoles      = authcore.ErrNoRoles
	ErrExpired      = authcore.ErrExpired
	ErrInvalid      = authcore.ErrInvalid
	ErrAuthDisabled = authcore.ErrAuthDisabled
)

// Function values rather than wrappers: a wrapper can drift in signature, a
// value cannot.
var (
	NewOIDCParser       = authcore.NewOIDCParser
	NewVerifier         = authcore.NewVerifier
	WithConsoleClientID = authcore.WithConsoleClientID
)
```

- [ ] **Step 3: Build platform-api and confirm all 65 importers compile**

Run: `cd platform-api && go build ./...`
Expected: no output. Any `undefined: auth.X` names something omitted from Step 2 — add it to the alias file rather than editing the caller.

- [ ] **Step 4: Write the alias-is-not-a-fork test**

Create `platform-api/internal/platform/auth/alias_test.go`:

```go
package auth_test

import (
	"testing"

	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// The alias layer exists so 65 importers need no edit. Its one failure mode is
// someone "fixing" a build error by writing a real constant here instead of an
// alias, at which point platform-api and secrets-api disagree about the
// vocabulary and nothing says so. This test is what says so.
func TestAliasesAreTheSameValuesNotCopies(t *testing.T) {
	if len(auth.Capabilities) != len(authcore.Capabilities) {
		t.Fatalf("capability count: alias has %d, platform-auth has %d",
			len(auth.Capabilities), len(authcore.Capabilities))
	}
	for i, want := range authcore.Capabilities {
		if auth.Capabilities[i] != want {
			t.Errorf("Capabilities[%d] = %q, platform-auth has %q", i, auth.Capabilities[i], want)
		}
	}

	pairs := []struct {
		name       string
		alias, src auth.Capability
	}{
		{"CapRead", auth.CapRead, authcore.CapRead},
		{"CapCRM", auth.CapCRM, authcore.CapCRM},
		{"CapSupport", auth.CapSupport, authcore.CapSupport},
		{"CapBilling", auth.CapBilling, authcore.CapBilling},
		{"CapPlatform", auth.CapPlatform, authcore.CapPlatform},
		{"CapRespond", auth.CapRespond, authcore.CapRespond},
		{"CapRotateCredentials", auth.CapRotateCredentials, authcore.CapRotateCredentials},
		{"CapAdjustBalance", auth.CapAdjustBalance, authcore.CapAdjustBalance},
		{"CapExecuteRefund", auth.CapExecuteRefund, authcore.CapExecuteRefund},
		{"CapMassSend", auth.CapMassSend, authcore.CapMassSend},
		{"CapHardDelete", auth.CapHardDelete, authcore.CapHardDelete},
		{"CapPublishCatalog", auth.CapPublishCatalog, authcore.CapPublishCatalog},
		{"CapReadPlanCatalog", auth.CapReadPlanCatalog, authcore.CapReadPlanCatalog},
	}
	for _, p := range pairs {
		if p.alias != p.src {
			t.Errorf("%s = %q, platform-auth has %q", p.name, p.alias, p.src)
		}
	}
}

// errors.Is must work across the module boundary, or every caller that checks
// for a specific verification failure silently stops matching.
func TestAliasedErrorsAreTheSameValues(t *testing.T) {
	errs := []struct {
		name       string
		alias, src error
	}{
		{"ErrNotJWT", auth.ErrNotJWT, authcore.ErrNotJWT},
		{"ErrAudience", auth.ErrAudience, authcore.ErrAudience},
		{"ErrNoRoles", auth.ErrNoRoles, authcore.ErrNoRoles},
		{"ErrExpired", auth.ErrExpired, authcore.ErrExpired},
		{"ErrInvalid", auth.ErrInvalid, authcore.ErrInvalid},
		{"ErrAuthDisabled", auth.ErrAuthDisabled, authcore.ErrAuthDisabled},
	}
	for _, e := range errs {
		if e.alias != e.src {
			t.Errorf("%s is a different error value from platform-auth's", e.name)
		}
	}
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd platform-api && go test ./internal/platform/auth/... -v -run TestAlias`
Expected: PASS on both tests.

- [ ] **Step 6: Mutate it to prove it bites**

Temporarily replace one alias with a copy in `alias.go` — change the const block line for `CapPlatform` to:

```go
	CapPlatform          = Capability("platform-ops")
```

Run: `cd platform-api && go test ./internal/platform/auth/... -run TestAlias`
Expected: FAIL — `CapPlatform = "platform-ops", platform-auth has "platform"`.

This is exactly the real-world mistake: a plausible-looking edit that silently forks the vocabulary. Revert (`git checkout platform-api/internal/platform/auth/alias.go`) and re-run: PASS.

- [ ] **Step 7: Run platform-api's full suite**

Run: `cd platform-api && go test ./...`
Expected: all packages ok. Note that 41 database tests skip unless `TESSERIX_TEST_DB_*` is exported — that is pre-existing and not caused by this change.

- [ ] **Step 8: Commit**

```bash
git add platform-api/internal/platform/auth/alias.go platform-api/internal/platform/auth/alias_test.go platform-api/go.mod platform-api/go.sum
git commit -m "refactor(auth): re-export platform-auth from platform-api so its 65 importers are unchanged"
```

---

### Task 3: Build wiring for the new module

Both Dockerfiles now build a module that depends on a sibling directory, and both workflows must rebuild when the shared vocabulary changes.

**Files:**
- Modify: `Dockerfile.secrets-api`
- Modify: `Dockerfile.platform-api`
- Modify: `.github/workflows/secrets-api.yml`
- Modify: `.github/workflows/platform-api.yml`

**Interfaces:**
- Consumes: the `platform-auth/` directory from Task 1.
- Produces: images that build. No Go API.

- [ ] **Step 1: Widen Dockerfile.secrets-api's build context**

Replace the builder stage's copy steps. The current file reads:

```dockerfile
FROM golang:1.26-alpine AS builder
WORKDIR /src

COPY secrets-api/go.mod secrets-api/go.sum ./
RUN go mod download

COPY secrets-api/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/server ./cmd/server
```

Change it to:

```dockerfile
FROM golang:1.26-alpine AS builder
WORKDIR /src

# Both modules, because secrets-api imports platform-auth. go.work is what
# resolves that import to the sibling directory rather than to a published
# version — there are no module tags in this repo.
COPY go.work ./
COPY secrets-api/go.mod secrets-api/go.sum ./secrets-api/
COPY platform-auth/go.mod platform-auth/go.sum ./platform-auth/
RUN go work edit -dropuse=./platform-api && go mod download all

COPY secrets-api/ ./secrets-api/
COPY platform-auth/ ./platform-auth/
WORKDIR /src/secrets-api
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/server ./cmd/server
```

`go work edit -dropuse=./platform-api` is what keeps `platform-api/` out of this image's build context — the workspace file lists three modules and only two are copied, which would otherwise fail.

- [ ] **Step 2: Verify the secrets-api image builds**

Run: `docker build --platform linux/amd64 -f Dockerfile.secrets-api -t secrets-api:plan-check .`
Expected: build succeeds.

If the base image will not pull locally, that is a known environment limitation on this machine, not a Dockerfile fault — the CI run on the pull request is the real gate. Record which happened rather than assuming.

- [ ] **Step 3: Apply the same widening to Dockerfile.platform-api**

Read the file first; it has the same shape. Copy `go.work`, both `go.mod`/`go.sum` pairs, drop `./secrets-api` from the workspace instead, then copy `platform-api/` and `platform-auth/` and build from `/src/platform-api`.

- [ ] **Step 4: Verify the platform-api image builds**

Run: `docker build --platform linux/amd64 -f Dockerfile.platform-api -t platform-api:plan-check .`
Expected: build succeeds.

- [ ] **Step 5: Add platform-auth to both workflow path filters**

In `.github/workflows/secrets-api.yml`, both the `push` and `pull_request` `paths:` lists currently read:

```yaml
      - 'secrets-api/**'
      - 'go.work'
      - 'Dockerfile.secrets-api'
      - '.github/workflows/secrets-api.yml'
```

Add `platform-auth/**` to each:

```yaml
      - 'secrets-api/**'
      - 'platform-auth/**'
      - 'go.work'
      - 'Dockerfile.secrets-api'
      - '.github/workflows/secrets-api.yml'
```

Without this, a change to the capability vocabulary would not rebuild the service that depends on it: the workflow would be skipped, the pull request would go green, and nothing would ship.

Make the equivalent edit in `.github/workflows/platform-api.yml`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.secrets-api Dockerfile.platform-api .github/workflows/secrets-api.yml .github/workflows/platform-api.yml
git commit -m "build: build both services against the platform-auth module and rebuild them when it changes"
```

---

### Task 4: A gin adapter over the shared Verifier

`platform-api`'s `Authenticate`/`RequireCapability` are `net/http`. `secrets-api` is gin, so it needs its own thin adapter. It shares the `Verifier`, the vocabulary and the refusal semantics — not the handler type.

**Files:**
- Create: `secrets-api/internal/api/middleware/bearer.go`
- Create: `secrets-api/internal/api/middleware/bearer_test.go`
- Modify: `secrets-api/go.mod`

**Interfaces:**
- Consumes: `authcore.Verifier`, `authcore.Principal`, `authcore.Capability`, `authcore.ErrNoRoles` from `github.com/tesserix/tesserix-home/platform-auth`.
- Produces:
  - `func RequireBearer(v *authcore.Verifier, log *slog.Logger) gin.HandlerFunc`
  - `func RequireCapability(required authcore.Capability) gin.HandlerFunc`
  - `func PrincipalFrom(c *gin.Context) (authcore.Principal, bool)` — **replaces** the existing `PrincipalFrom` returning the session `Principal`. Callers move from `p.Email` to `p.Subject` in Task 6.

- [ ] **Step 1: Add the dependency**

```bash
cd /path/to/tesserix-home/secrets-api
go mod edit -require=github.com/tesserix/tesserix-home/platform-auth@v0.0.0
```

- [ ] **Step 2: Write the failing tests**

Create `secrets-api/internal/api/middleware/bearer_test.go`:

```go
package middleware_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
)

// stubParser stands in for Zitadel. The Verifier's policy — audience, roles,
// expiry, principal shape — is what we are testing here, not JWKS.
type stubParser struct {
	claims *authcore.Claims
	err    error
}

func (s stubParser) Parse(context.Context, string) (*authcore.Claims, error) {
	return s.claims, s.err
}

const testProject = "386377229942128837"

func verifierWith(roles []string) *authcore.Verifier {
	return authcore.NewVerifier(stubParser{claims: &authcore.Claims{
		Subject:   "user-1",
		Audience:  []string{testProject},
		Roles:     roles,
		ExpiresAt: time.Now().Add(time.Hour),
	}}, testProject)
}

func request(t *testing.T, h gin.HandlerFunc, gate gin.HandlerFunc, header string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	handlers := []gin.HandlerFunc{h}
	if gate != nil {
		handlers = append(handlers, gate)
	}
	handlers = append(handlers, func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/x", handlers...)

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if header != "" {
		req.Header.Set("Authorization", header)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestNoAuthorizationHeaderIs401(t *testing.T) {
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestNonBearerSchemeIs401(t *testing.T) {
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "Basic abc")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestValidTokenPasses(t *testing.T) {
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "Bearer a.b.c")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

// A capability the principal does not hold must be 403, not 401: the caller IS
// authenticated. Collapsing them would tell a legitimate operator to log in
// again for a permission they were never granted.
func TestMissingCapabilityIs403(t *testing.T) {
	w := request(t,
		middleware.RequireBearer(verifierWith([]string{"platform"}), nil),
		middleware.RequireCapability(authcore.CapRotateCredentials),
		"Bearer a.b.c")
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestHeldCapabilityPasses(t *testing.T) {
	w := request(t,
		middleware.RequireBearer(verifierWith([]string{"platform", "rotate-credentials"}), nil),
		middleware.RequireCapability(authcore.CapRotateCredentials),
		"Bearer a.b.c")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

// RequireCapability reached without RequireBearer must refuse. This is the
// fail-closed property: a route group wired in the wrong order denies rather
// than allows.
func TestCapabilityGateWithoutAuthenticationIs401(t *testing.T) {
	w := request(t, middleware.RequireCapability(authcore.CapPlatform), nil, "Bearer a.b.c")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestPrincipalIsAvailableToHandlers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var got authcore.Principal
	var ok bool
	r.GET("/x", middleware.RequireBearer(verifierWith([]string{"platform"}), nil), func(c *gin.Context) {
		got, ok = middleware.PrincipalFrom(c)
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer a.b.c")
	r.ServeHTTP(httptest.NewRecorder(), req)

	if !ok {
		t.Fatal("PrincipalFrom reported no principal")
	}
	if got.Subject != "user-1" {
		t.Errorf("Subject = %q, want user-1", got.Subject)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd secrets-api && go test ./internal/api/middleware/... -run 'TestNoAuthorization|TestNonBearer|TestValidToken|TestMissingCapability|TestHeldCapability|TestCapabilityGateWithout|TestPrincipalIsAvailable'`
Expected: FAIL to compile — `undefined: middleware.RequireBearer`.

- [ ] **Step 4: Write the implementation**

Create `secrets-api/internal/api/middleware/bearer.go`:

```go
package middleware

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	authcore "github.com/tesserix/tesserix-home/platform-auth"
)

// principalKey is unexported so nothing outside this package can plant a
// principal on the context. PrincipalFrom is the only way in.
const principalKey = "auth.principal"

// RequireBearer verifies the Zitadel bearer token and attaches the principal.
//
// It does NOT authorise. Keeping verification and authorisation in separate
// middleware is what lets each route state the capability it needs, instead of
// one gate deciding for routes it cannot see.
func RequireBearer(v *authcore.Verifier, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, ok := bearerToken(c.Request)
		if !ok {
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}

		principal, err := v.Verify(c.Request.Context(), raw)
		if err != nil {
			// The reason goes to the log, never to the caller: ErrNoRoles names
			// the role vocabulary, and reporting it would hand that vocabulary
			// to an unauthorised client.
			if log != nil {
				log.Warn("token rejected", "error", err, "path", c.Request.URL.Path)
			}
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}

		c.Set(principalKey, *principal)
		c.Next()
	}
}

// RequireCapability refuses a request whose principal lacks `required`.
//
// Reached without RequireBearer it refuses with 401 rather than passing: a
// route group wired in the wrong order must deny, not allow.
func RequireCapability(required authcore.Capability) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := PrincipalFrom(c)
		if !ok {
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}
		if !principal.Has(required) {
			// 403, not 401: the caller is authenticated and simply lacks this
			// permission. Telling them to log in again would be a lie.
			abort(c, http.StatusForbidden, "insufficient permissions")
			return
		}
		c.Next()
	}
}

// PrincipalFrom returns the principal a request was authenticated as.
//
// The bool is not decoration: a handler reached without authentication has a
// zero Principal, which holds no capabilities, and silently treating that as a
// real caller is how an ungated route becomes an open one.
func PrincipalFrom(c *gin.Context) (authcore.Principal, bool) {
	v, ok := c.Get(principalKey)
	if !ok {
		return authcore.Principal{}, false
	}
	p, ok := v.(authcore.Principal)
	return p, ok
}

func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	scheme, token, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}
```

`abort` already exists in this package (`session.go`). Task 6 deletes `session.go`; move `abort` into `bearer.go` at that point rather than now, so this task's diff stays additive.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd secrets-api && go test ./internal/api/middleware/...`
Expected: ok.

- [ ] **Step 6: Mutate each guarded property**

Run each mutation, confirm the named test fails, then revert with `git checkout secrets-api/internal/api/middleware/bearer.go` and confirm green again.

| mutation in `bearer.go` | must fail |
|---|---|
| in `RequireCapability`, change `if !ok {` to `if false {` | `TestCapabilityGateWithoutAuthenticationIs401` |
| in `RequireCapability`, change `http.StatusForbidden` to `http.StatusUnauthorized` | `TestMissingCapabilityIs403` |
| in `RequireCapability`, change `if !principal.Has(required)` to `if false` | `TestMissingCapabilityIs403` |
| in `bearerToken`, drop the `EqualFold(scheme, "bearer")` check | `TestNonBearerSchemeIs401` |

If any mutation leaves the suite green, the test is not testing what it claims and must be fixed before moving on.

- [ ] **Step 7: Commit**

```bash
git add secrets-api/internal/api/middleware/bearer.go secrets-api/internal/api/middleware/bearer_test.go secrets-api/go.mod secrets-api/go.sum
git commit -m "feat(secrets-api): verify Zitadel bearer tokens and gate routes by capability"
```

---

### Task 5: Zitadel configuration

Additive only. The Google fields stay until Task 7 so every commit compiles.

**Files:**
- Modify: `secrets-api/internal/config/config.go`
- Modify: `secrets-api/internal/config/config_test.go`
- Modify: `secrets-api/cmd/server/main.go`

**Interfaces:**
- Consumes: `authcore.NewOIDCParser`, `authcore.NewVerifier`, `authcore.WithConsoleClientID`.
- Produces: `Config.ZitadelIssuer`, `Config.ZitadelProjectID`, `Config.ConsoleClientID` (all `string`), and a `*authcore.Verifier` built in `main.go`.

- [ ] **Step 1: Write the failing config tests**

Add to `secrets-api/internal/config/config_test.go`. Read the file first and follow its existing table idiom for building a `Lookup`.

```go
func TestZitadelConfigIsRequired(t *testing.T) {
	base := validEnv() // the helper this file already uses for a complete env
	for _, missing := range []string{"ZITADEL_ISSUER", "ZITADEL_PROJECT_ID"} {
		t.Run(missing, func(t *testing.T) {
			env := copyEnv(base)
			delete(env, missing)
			if _, err := config.Load(lookupFrom(env)); err == nil {
				t.Fatalf("Load succeeded with %s unset; it must refuse", missing)
			}
		})
	}
}

// Unset CONSOLE_CLIENT_ID is allowed and costs attribution, not access: every
// principal is then recorded as a service. Refusing to start over it would
// take the service down for a logging concern.
func TestConsoleClientIDIsOptional(t *testing.T) {
	env := copyEnv(validEnv())
	delete(env, "CONSOLE_CLIENT_ID")
	cfg, err := config.Load(lookupFrom(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ConsoleClientID != "" {
		t.Errorf("ConsoleClientID = %q, want empty", cfg.ConsoleClientID)
	}
}
```

If `validEnv`, `copyEnv` or `lookupFrom` do not exist under those names, use whatever the file already provides and keep the assertions identical.

- [ ] **Step 2: Run to verify failure**

Run: `cd secrets-api && go test ./internal/config/... -run TestZitadel`
Expected: FAIL — `Load succeeded with ZITADEL_ISSUER unset`.

- [ ] **Step 3: Add the fields and their validation**

In `secrets-api/internal/config/config.go`, add to the `Config` struct after `AdminEmails`:

```go
	// Zitadel is the only identity provider. ZitadelProjectID doubles as the
	// expected token audience, which is why it is required: without it the
	// verifier would accept a token minted for any other project.
	ZitadelIssuer    string
	ZitadelProjectID string
	// ConsoleClientID names the client whose tokens are operators rather than
	// machines. Optional: unset costs attribution, not access.
	ConsoleClientID string
```

In `Load`, alongside the existing `get(...)` calls:

```go
	cfg.ZitadelIssuer = strings.TrimSpace(get("ZITADEL_ISSUER"))
	cfg.ZitadelProjectID = strings.TrimSpace(get("ZITADEL_PROJECT_ID"))
	cfg.ConsoleClientID = strings.TrimSpace(get("CONSOLE_CLIENT_ID"))
```

And add both to the existing required-variable slice that `config.go:99` builds:

```go
		{"ZITADEL_ISSUER", cfg.ZitadelIssuer},
		{"ZITADEL_PROJECT_ID", cfg.ZitadelProjectID},
```

- [ ] **Step 4: Run to verify pass**

Run: `cd secrets-api && go test ./internal/config/...`
Expected: ok.

- [ ] **Step 5: Build the verifier in main.go**

Read `secrets-api/cmd/server/main.go` and add, after config load and before the router is built:

```go
	parser, err := authcore.NewOIDCParser(ctx, cfg.ZitadelIssuer, cfg.ZitadelProjectID)
	if err != nil {
		// Discovery is a network call at startup. Failing here rather than
		// per-request means a misconfigured issuer is a crash-loop, which is
		// visible, instead of a service that authenticates nobody.
		log.Error("zitadel discovery failed", "error", err)
		os.Exit(1)
	}

	opts := []authcore.Option{}
	if cfg.ConsoleClientID != "" {
		opts = append(opts, authcore.WithConsoleClientID(cfg.ConsoleClientID))
	}
	verifier := authcore.NewVerifier(parser, cfg.ZitadelProjectID, opts...)
```

Add `verifier` to the `api.Deps` literal, and add the field to `Deps` in `secrets-api/internal/api/server.go`:

```go
	Verifier *authcore.Verifier
```

- [ ] **Step 6: Build**

Run: `cd secrets-api && go build ./...`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add secrets-api/internal/config/ secrets-api/cmd/server/main.go secrets-api/internal/api/server.go
git commit -m "feat(secrets-api): read Zitadel issuer, project and console client from the environment"
```

---

### Task 6: Swap the route gates, and prove none is missing

The switch. After this the service authorises by capability.

**Files:**
- Modify: `secrets-api/internal/api/server.go:43-87`
- Create: `secrets-api/internal/api/routes_test.go`
- Modify: `secrets-api/internal/api/handlers/{access,reviews,whitelist,secrets}.go` — `p.Email` → `p.Subject`
- Modify: `secrets-api/internal/api/middleware/common.go:61` — same

**Interfaces:**
- Consumes: `middleware.RequireBearer`, `middleware.RequireCapability`, `middleware.PrincipalFrom` from Task 4; `Deps.Verifier` from Task 5.
- Produces: a router whose every route carries a gate.

- [ ] **Step 1: Write the route-completeness test**

Create `secrets-api/internal/api/routes_test.go`:

```go
package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api"
)

// publicRoutes is an allowlist, and that direction is the whole point. Per-route
// tests prove the gates someone remembered; this proves there are no others.
// A route added in six months and left ungated fails here, which is the only
// test that can catch it.
var publicRoutes = map[string]bool{
	"GET /healthz": true,
	"GET /readyz":  true,
}

func TestEveryRouteIsGatedOrExplicitlyPublic(t *testing.T) {
	r := api.NewRouter(testDeps(t))

	for _, route := range r.Routes() {
		key := route.Method + " " + route.Path
		if publicRoutes[key] {
			continue
		}

		req := httptest.NewRequest(route.Method, concretePath(route.Path), nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		// No credentials at all must never reach a handler. 401 is the only
		// correct answer; a 200, a 400 from body binding, or a 404 all mean the
		// request got past authentication.
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s answered %d without credentials, want 401 — is it gated?", key, w.Code)
		}
	}
}

// concretePath replaces gin's :param and *path wildcards so the request routes.
func concretePath(pattern string) string {
	out := ""
	for _, segment := range splitPath(pattern) {
		switch {
		case segment == "":
			continue
		case segment[0] == ':' || segment[0] == '*':
			out += "/x"
		default:
			out += "/" + segment
		}
	}
	if out == "" {
		return "/"
	}
	return out
}
```

Write `splitPath` as a plain `strings.Split(pattern, "/")` helper in the same file, and `testDeps(t)` returning an `api.Deps` with a `Verifier` built from a stub parser and every other dependency nil. `NewRouter` already tolerates `d.Bao == nil`; if any other nil dependency panics at construction, supply the narrowest stub that does not.

- [ ] **Step 2: Run to verify it fails**

Run: `cd secrets-api && go test ./internal/api/... -run TestEveryRouteIsGated`
Expected: FAIL, listing the `/api/auth/*` routes and any route still on the session gate.

- [ ] **Step 3: Rewrite the route groups**

Replace `secrets-api/internal/api/server.go` lines 66–85 (from `authHandler := ...` to the closing of the guarded group) with:

```go
	// Everything below requires a verified Zitadel token. The two groups differ
	// only in the capability they demand.
	//
	// The split follows EFFECT, not HTTP verb. POST /api/access/grants looks
	// like a proposal and is not: CreateGrant writes OpenBao immediately and
	// then opens a pull request to record what it already did. Gating by method
	// would have put that in the same tier as /api/access/whitelist, which
	// really does nothing until a human merges it.
	authed := r.Group("/",
		middleware.RequireBearer(d.Verifier, d.Log),
		middleware.RequireCapability(authcore.CapPlatform),
	)

	// Routes that change live state — OpenBao, Google Secret Manager, or a
	// merge into tesserix-k8s — additionally need the credential verb.
	live := authed.Group("/", middleware.RequireCapability(authcore.CapRotateCredentials))

	handlers.NewSecrets(d.Secrets, d.Audit).Register(authed, live)
	if d.Bao != nil {
		handlers.NewAccess(d.Bao, d.Whitelist, d.Audit).Register(authed, live)
	}
	handlers.NewCluster(d.Discovery).Register(authed)
	handlers.NewWhitelist(d.Whitelist, d.Audit).Register(authed)
	handlers.NewReviews(d.Reviews, d.Audit).Register(authed, live)
```

Then change each handler's `Register` to take the groups it needs, splitting its routes per spec §4's table:

`secrets.go`:
```go
func (h *Secrets) Register(read, live gin.IRoutes) {
	read.GET("/api/backends", h.Backends)
	read.GET("/api/backends/status", h.Status)
	read.GET("/api/secrets", h.List)
	read.GET("/api/secrets/*path", h.Describe)
	read.GET("/api/secret-versions/*path", h.Versions)

	live.PUT("/api/secrets/*path", h.Write)
	live.DELETE("/api/secrets/*path", h.Delete)
	live.POST("/api/secret-versions/*path", h.Restore)
}
```

`access.go`:
```go
func (h *Access) Register(read, live gin.IRoutes) {
	read.GET("/api/access/grants", h.ListGrants)
	read.GET("/api/access/denied", h.ListDenied)

	// GrantAll and bao.Allow/Deny take effect in OpenBao immediately; the
	// proposal they open afterwards is a receipt, not a gate.
	live.POST("/api/access/grants", h.CreateGrant)
	live.DELETE("/api/access/grants/:namespace/:app", h.RevokeGrant)
	live.POST("/api/access/denied", h.Deny)
	live.DELETE("/api/access/denied/:namespace", h.Allow)
}
```

`reviews.go`:
```go
func (h *Reviews) Register(read, live gin.IRoutes) {
	read.GET("/api/reviews", h.List)
	read.GET("/api/reviews/:number", h.Show)

	live.POST("/api/reviews/:number/approve", h.Approve)
	live.POST("/api/reviews/:number/merge", h.Merge)
	live.POST("/api/reviews/:number/reject", h.Reject)
}
```

`whitelist.go` and `cluster.go` keep their single-group signature: every whitelist and wiring route only opens a pull request, and every cluster route is a read.

Delete these three lines from `NewRouter`:

```go
	authHandler := handlers.NewAuth(d.Config, d.Flow, d.Sealer, d.Allow, d.Audit)
	authHandler.Register(r)
	guarded.GET("/api/auth/me", authHandler.Me)
```

- [ ] **Step 4: Move the actor from email to subject**

In each of `handlers/{access,reviews,whitelist,secrets}.go` and `middleware/common.go`, change:

```go
		actor = p.Email
```

to:

```go
		actor = p.Subject
```

There are 8 files containing `PrincipalFrom`; `handlers/auth.go` and `handlers/auth_test.go` are deleted in Task 7 and need no edit here.

- [ ] **Step 5: Run the completeness test**

Run: `cd secrets-api && go test ./internal/api/... -run TestEveryRouteIsGated -v`
Expected: PASS.

- [ ] **Step 6: Mutate it to prove it bites**

Temporarily register a route outside the groups — add to `NewRouter`, just before `return r`:

```go
	r.GET("/api/oops", func(c *gin.Context) { c.Status(http.StatusOK) })
```

Run: `cd secrets-api && go test ./internal/api/... -run TestEveryRouteIsGated`
Expected: FAIL — `GET /api/oops answered 200 without credentials, want 401 — is it gated?`

This is precisely the failure the test exists for. Revert and re-run: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `cd secrets-api && go test ./...`
Expected: failures only in `handlers/auth_test.go` and the session/CSRF tests, which Task 7 deletes. Record which fail so Task 7 can confirm it removed exactly those and nothing else.

- [ ] **Step 8: Commit**

```bash
git add secrets-api/internal/api/
git commit -m "feat(secrets-api): gate every route by capability, following effect rather than HTTP verb"
```

---

### Task 7: Delete the cookie stack

Only now, when nothing depends on it.

**Files:**
- Delete: `secrets-api/internal/auth/{oidc,oidc_test,pkce,pkce_test,loginstate,loginstate_test,session,session_test,allowlist,allowlist_test}.go`
- Delete: `secrets-api/internal/api/handlers/{auth,auth_test}.go`
- Delete: `secrets-api/internal/api/middleware/{session,session_test,csrf,csrf_test}.go`
- Modify: `secrets-api/internal/api/middleware/bearer.go` — absorb `abort`
- Modify: `secrets-api/internal/api/server.go` — CORS, `Deps`
- Modify: `secrets-api/internal/config/config.go`, `config_test.go`
- Modify: `secrets-api/cmd/server/main.go`

**Interfaces:**
- Consumes: everything from Tasks 4–6.
- Produces: a service with no session, no CSRF, and no Google configuration.

- [ ] **Step 1: Move `abort` into bearer.go**

Copy the `abort` function from `middleware/session.go` verbatim into `middleware/bearer.go` before deleting the file.

- [ ] **Step 2: Delete the files**

```bash
cd /path/to/tesserix-home
git rm secrets-api/internal/auth/oidc.go secrets-api/internal/auth/oidc_test.go \
       secrets-api/internal/auth/pkce.go secrets-api/internal/auth/pkce_test.go \
       secrets-api/internal/auth/loginstate.go secrets-api/internal/auth/loginstate_test.go \
       secrets-api/internal/auth/session.go secrets-api/internal/auth/session_test.go \
       secrets-api/internal/auth/allowlist.go secrets-api/internal/auth/allowlist_test.go
git rm secrets-api/internal/api/handlers/auth.go secrets-api/internal/api/handlers/auth_test.go
git rm secrets-api/internal/api/middleware/session.go secrets-api/internal/api/middleware/session_test.go
git rm secrets-api/internal/api/middleware/csrf.go secrets-api/internal/api/middleware/csrf_test.go
```

**CSRF is deleted in the same commit as the cookie, and that ordering is not negotiable.** CSRF defends an *ambient* credential — one the browser attaches automatically. A bearer token attached by server-side console code is not ambient, so there is nothing left to defend. Deleting CSRF while a cookie still authenticated requests would be a hole; deleting both together closes the class.

- [ ] **Step 3: Strip the CORS credentials block**

In `server.go`, replace the `cors.New(...)` call with:

```go
	// No AllowCredentials and no AllowedOrigins: no browser talks to this
	// service. The only caller is the console's server-side code, which is not
	// subject to the same-origin policy at all.
	r.Use(cors.New(cors.Config{
		AllowMethods: []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete},
		AllowHeaders: []string{"Content-Type", "Authorization", middleware.RequestIDHeader},
	}))
```

Remove `middleware.CSRFHeaderName` from the header list — it no longer exists.

- [ ] **Step 4: Remove the dead Deps fields**

Delete `Flow`, `Sealer` and `Allow` from `api.Deps` in `server.go` and from the `Deps` literal in `main.go`, along with whatever constructs them.

- [ ] **Step 5: Remove the dead config**

In `config.go`, delete from `Config`: `ClientID`, `ClientSecret`, `RedirectURL`, `SessionKey`, `SessionTTL`, `AdminEmails`. Delete their `get(...)` calls in `Load`, their entries in the required-variable slice, and the `ADMIN_EMAILS must list at least one address` check at `config.go:127`.

Delete the corresponding cases in `config_test.go`. Keep every other test.

- [ ] **Step 6: Build and run everything**

Run: `cd secrets-api && go build ./... && go test ./...`
Expected: all packages ok, with no failures. Compare against the list recorded in Task 6 Step 7 — the failures that disappear must be exactly the auth/session/CSRF ones. Anything else that changed state is a regression to investigate, not to accept.

- [ ] **Step 7: Confirm nothing references the removed configuration**

Run: `cd secrets-api && grep -rn "ADMIN_EMAILS\|GOOGLE_CLIENT\|SESSION_KEY\|CSRF\|Allowlist\|Sealer" --include="*.go" .`
Expected: no output.

- [ ] **Step 8: Verify formatting and tidiness the way CI will**

Run: `cd secrets-api && gofmt -l . && go vet ./... && go mod tidy && git diff --exit-code go.mod go.sum`
Expected: no output from any of them. `secrets-api.yml` fails the build on unformatted files and on a `go.mod` that is not tidy, so this catches it before CI does.

- [ ] **Step 9: Commit**

```bash
git add -A secrets-api/
git commit -m "refactor(secrets-api): delete the session, CSRF and Google OAuth stack"
```

---

### Task 8: Open the pull request

**Files:** none.

- [ ] **Step 1: Confirm the whole workspace is green**

```bash
cd /path/to/tesserix-home
(cd platform-auth && go test ./...)
(cd platform-api && go test ./...)
(cd secrets-api && go test ./...)
```

Expected: all ok. Do not pipe through `tail -N` — a truncated failure loses the test name, and finding it again costs more than reading the full output.

- [ ] **Step 2: Push from a worktree, but create the PR from the main checkout**

`gh pr create` fails from a git worktree with a misleading Enterprise Managed User "Unauthorized" error. Push from wherever you are, then:

```bash
cd /path/to/tesserix-home   # the main checkout, not the worktree
gh pr create -R tesserix/tesserix-home -B main -H <branch> \
  --title "feat(secrets-api): authenticate with Zitadel and authorise by capability" \
  --body-file /path/to/body.md
```

- [ ] **Step 3: State plainly in the PR body that this does not deploy**

`secrets-api`'s image tag is pinned in `tesserix-k8s`, so merging publishes an image and changes nothing running. The cutover is a later chart PR. A reviewer who assumes otherwise will review this far more anxiously than it deserves — and one who assumes the opposite about `platform-api` will review it too casually, since **that** one does deploy on merge.

---

## Self-review

**Spec coverage.** §2 shape change → Tasks 4–7. §3 shared module → Tasks 1–3, with the `reqid` correction recorded at the top. §4 authorisation → Tasks 4 and 6. §5 identity → Task 5 (`ConsoleClientID`) and Task 6 Step 4 (`p.Subject`). §9 steps 1–2 → this plan; steps 3–6 are out of scope and named as such. §10 tests → route completeness (Task 6), alias-is-not-a-fork (Task 2), mutation discipline throughout.

**Not covered here, by design:** §6 (console call path), §7 (networking), §8 (devai broker — unsolved deliberately), §10's `Store` has-no-`Read` test. The `Store` test belongs with the console surface phase, where §6's guarantee becomes user-visible; if that phase slips, file it separately rather than losing it.

**Type consistency.** `PrincipalFrom` returns `authcore.Principal` in Task 4 and is consumed as such in Task 6. `Register` signatures change from `(r gin.IRoutes)` to `(read, live gin.IRoutes)` only for `Secrets`, `Access` and `Reviews`; `Whitelist` and `Cluster` keep the single-group form, and Task 6 Step 3's `NewRouter` calls match.
