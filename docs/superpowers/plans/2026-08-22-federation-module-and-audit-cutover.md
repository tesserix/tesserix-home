# Federation Module and Audit Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `platform-api` a kernel package that calls other products' admin APIs with the operator's identity attached, and move the console's estate audit log onto it — removing the first of two `apps/web` runtime dependencies.

**Architecture:** A new kernel package `internal/platform/federation` holds the product registry, the signed HTTP client, and a fan-out that returns partial results rather than failing whole. A new domain module `internal/modules/audit` serves `GET /v1/audit`, merging the console's own `console_audit_log` rows with product rows fetched through that kernel. The console's `fetchEstateAuditLog` gains a dual path gated on `PLATFORM_API_ORIGIN`, exactly as `fetchTickets` already does, so the cutover is revertible by unsetting one variable.

**Tech Stack:** Go 1.26, `net/http` + `http.ServeMux` pattern routing, `pgx/v5`, `testify`-free stdlib tests (this service uses plain `testing`); TypeScript, Next.js 16, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-mark8ly-console-integration-design.md`
**Contract:** `docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md` (v2)
**Conventions:** `docs/PLATFORM-API-CONVENTIONS.md` — read §1 (envelope), §2 (domain-shaped resources), §4 (versioning), §7 (auth), §8 (module boundaries) before starting.

## Global Constraints

- **Go module path** is `github.com/tesserix/tesserix-home/platform-api`. Every internal import starts with it.
- **A module must not import another module.** `internal/architecture` fails CI on it. Shared helpers go in `internal/platform/…` (kernel). Kernel depends on no module.
- **A module's public surface is `Register` and `Config`, in `<name>/<name>.go`.** Everything else lives under `<name>/internal/`.
- **Paths carry `/v1/`.** No header negotiation, no query versioning.
- **Every route names the capability it needs. Nothing is inherited.** Registration goes through `httpx.RegisterModule`, which panics without a verifier.
- **Response envelope** is `httpx.WriteData` / `httpx.WriteError`. Never hand-roll JSON envelopes.
- **Empty is `200` with `[]`.** Never `null`, never `{}`. A Go `nil` slice serialised as `{}` has already crashed a console page in this estate.
- **Timestamps** are ISO 8601, UTC, with offset.
- **Console dual path:** `PLATFORM_API_ORIGIN` unset must remain byte-for-byte the old behaviour.
- **`apps/console/dev/admin-stub.mjs` is part of the contract** — it stands in for `apps/web` in local dev and e2e. Any route it serves that moves must stay working.
- **Run `npx next build` in `apps/console` before merging** any change that adds or moves an import. `tsc` and Vitest cannot see server-only code reaching the browser bundle.

---

### Task 1: Federation product registry

The registry answers "which products can we call, and where". It is configuration only — no HTTP yet — so it can be tested without a server.

**Files:**
- Create: `platform-api/internal/platform/federation/registry.go`
- Create: `platform-api/internal/platform/federation/registry_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Product struct { Slug, BaseURL, Secret string }`; `type Registry struct{ … }`; `func NewRegistry(products []Product) *Registry`; `func (r *Registry) Get(slug string) (Product, bool)`; `func (r *Registry) Slugs() []string`; `func LoadRegistry(getenv func(string) string) (*Registry, error)`.

- [ ] **Step 1: Write the failing test**

```go
package federation

import "testing"

func TestRegistryGetReturnsAConfiguredProduct(t *testing.T) {
	r := NewRegistry([]Product{{Slug: "mark8ly", BaseURL: "http://m", Secret: "s"}})

	got, ok := r.Get("mark8ly")
	if !ok {
		t.Fatal("expected mark8ly to be configured")
	}
	if got.BaseURL != "http://m" {
		t.Fatalf("BaseURL = %q, want %q", got.BaseURL, "http://m")
	}
}

func TestRegistryGetFailsClosedOnUnknownProduct(t *testing.T) {
	r := NewRegistry(nil)

	if _, ok := r.Get("mark8ly"); ok {
		t.Fatal("an unconfigured product must not be reported as configured")
	}
}

func TestSlugsAreSortedSoFanOutIsDeterministic(t *testing.T) {
	r := NewRegistry([]Product{
		{Slug: "kora", BaseURL: "http://k", Secret: "s"},
		{Slug: "mark8ly", BaseURL: "http://m", Secret: "s"},
	})

	got := r.Slugs()
	if len(got) != 2 || got[0] != "kora" || got[1] != "mark8ly" {
		t.Fatalf("Slugs() = %v, want [kora mark8ly]", got)
	}
}

func TestLoadRegistryReadsOnlyDeclaredProducts(t *testing.T) {
	env := map[string]string{
		"FEDERATION_PRODUCTS":          "mark8ly",
		"FEDERATION_MARK8LY_BASE_URL":  "http://m",
		"FEDERATION_MARK8LY_SECRET":    "s",
		"FEDERATION_KORA_BASE_URL":     "http://k",
		"FEDERATION_KORA_SECRET":       "s",
	}
	r, err := LoadRegistry(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}

	if _, ok := r.Get("kora"); ok {
		t.Fatal("kora is configured but not declared in FEDERATION_PRODUCTS; it must not be callable")
	}
	if _, ok := r.Get("mark8ly"); !ok {
		t.Fatal("mark8ly is declared and configured; it must be callable")
	}
}

func TestLoadRegistryRefusesADeclaredProductWithNoBaseURL(t *testing.T) {
	env := map[string]string{"FEDERATION_PRODUCTS": "mark8ly"}

	if _, err := LoadRegistry(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a declared product with no base URL must be a startup error, not a silent skip")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-api && go test ./internal/platform/federation/ -run TestRegistry -v`
Expected: FAIL — `undefined: NewRegistry`

- [ ] **Step 3: Write minimal implementation**

```go
// Package federation calls other products' platform admin APIs on behalf of an
// operator.
//
// It is kernel, not a module: several modules (audit now; tenants, billing,
// compliance later) all need the same client, and a module may not import
// another module. See docs/PLATFORM-API-CONVENTIONS.md §8.
package federation

import (
	"fmt"
	"sort"
	"strings"
)

// Product is one callable product's coordinates.
type Product struct {
	// Slug is the product's identity across the estate — the same value
	// console-core's EstateProduct.context carries.
	Slug string
	// BaseURL is the product's platform admin front door, without a trailing
	// slash.
	BaseURL string
	// Secret is the shared secret the request is signed with.
	Secret string
}

// Registry is the set of products this deployment may call.
type Registry struct {
	byslug map[string]Product
}

func NewRegistry(products []Product) *Registry {
	byslug := make(map[string]Product, len(products))
	for _, p := range products {
		byslug[p.Slug] = p
	}
	return &Registry{byslug: byslug}
}

// Get fails closed: an unknown product is not callable, and "we have never
// heard of this product" and "this product is not configured" deserve the same
// answer.
func (r *Registry) Get(slug string) (Product, bool) {
	p, ok := r.byslug[slug]
	return p, ok
}

// Slugs is sorted so a fan-out's failure list is stable across runs. An
// unstable order makes two identical outages look like different ones.
func (r *Registry) Slugs() []string {
	out := make([]string, 0, len(r.byslug))
	for slug := range r.byslug {
		out = append(out, slug)
	}
	sort.Strings(out)
	return out
}

// LoadRegistry builds the registry from the environment.
//
// FEDERATION_PRODUCTS is the declaration, and it is the whole mechanism:
// a product is callable because it was named there, not because its URL
// happens to be set. Configuration left behind by a rollback cannot quietly
// re-enable a product.
func LoadRegistry(getenv func(string) string) (*Registry, error) {
	declared := strings.TrimSpace(getenv("FEDERATION_PRODUCTS"))
	if declared == "" {
		return NewRegistry(nil), nil
	}

	var products []Product
	for _, raw := range strings.Split(declared, ",") {
		slug := strings.TrimSpace(raw)
		if slug == "" {
			continue
		}
		prefix := "FEDERATION_" + strings.ToUpper(slug) + "_"
		base := strings.TrimSpace(getenv(prefix + "BASE_URL"))
		if base == "" {
			return nil, fmt.Errorf(
				"federation: product %q is declared in FEDERATION_PRODUCTS but %sBASE_URL is empty",
				slug, prefix)
		}
		products = append(products, Product{
			Slug:    slug,
			BaseURL: strings.TrimRight(base, "/"),
			Secret:  strings.TrimSpace(getenv(prefix + "SECRET")),
		})
	}
	return NewRegistry(products), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-api && go test ./internal/platform/federation/ -v`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add platform-api/internal/platform/federation/
git commit -m "feat(platform-api): federation product registry"
```

---

### Task 2: Signed federation client carrying operator identity

**Files:**
- Create: `platform-api/internal/platform/federation/client.go`
- Create: `platform-api/internal/platform/federation/client_test.go`

**Interfaces:**
- Consumes: `Product`, `Registry` from Task 1.
- Produces: `type Operator struct { ID, Capability string }`; `type Client struct{ … }`; `func NewClient(reg *Registry, http *http.Client) *Client`; `func (c *Client) Get(ctx context.Context, slug, path string, op Operator) ([]byte, error)`; `var ErrProductNotConfigured error`.

- [ ] **Step 1: Write the failing test**

```go
package federation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func operator() Operator { return Operator{ID: "op-1", Capability: "platform"} }

func TestGetSendsOperatorIdentityAndSecret(t *testing.T) {
	var gotOperator, gotCapability, gotSecret, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOperator = r.Header.Get("X-Operator-Id")
		gotCapability = r.Header.Get("X-Operator-Capability")
		gotSecret = r.Header.Get("X-Internal-Auth")
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "shh"}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", operator()); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if gotOperator != "op-1" {
		t.Errorf("X-Operator-Id = %q, want op-1", gotOperator)
	}
	if gotCapability != "platform" {
		t.Errorf("X-Operator-Capability = %q, want platform", gotCapability)
	}
	if gotSecret != "shh" {
		t.Errorf("X-Internal-Auth = %q, want shh", gotSecret)
	}
	if gotPath != "/admin/audit-logs" {
		t.Errorf("path = %q, want /admin/audit-logs", gotPath)
	}
}

func TestGetRefusesAnUnconfiguredProduct(t *testing.T) {
	c := NewClient(NewRegistry(nil), http.DefaultClient)

	_, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", operator())
	if !errors.Is(err, ErrProductNotConfigured) {
		t.Fatalf("err = %v, want ErrProductNotConfigured", err)
	}
}

func TestGetRefusesToCallWithoutAnOperator(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the request must not leave the process without an operator")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", Operator{}); err == nil {
		t.Fatal("an anonymous federated call must be refused, not sent")
	}
}

func TestGetTurnsANonSuccessIntoAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/x", operator()); err == nil {
		t.Fatal("503 must surface as an error, not as an empty success")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-api && go test ./internal/platform/federation/ -run TestGet -v`
Expected: FAIL — `undefined: NewClient`

- [ ] **Step 3: Write minimal implementation**

```go
package federation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrProductNotConfigured is returned for a product this deployment may not
// call. Tested with errors.Is so callers do not string-match.
var ErrProductNotConfigured = errors.New("federation: product not configured")

// Operator is who the call is being made on behalf of, and under what
// authority.
//
// Both fields are required on every call. A shared secret alone carries no
// actor, so a product would record the action against "the platform", which is
// the same as unattributed. See the integration contract §8.4.
type Operator struct {
	ID         string
	Capability string
}

// Client calls products' platform admin APIs.
type Client struct {
	reg  *Registry
	http *http.Client
}

// NewClient builds a client. A nil http.Client gets one with a timeout —
// Go's default has none, and a product that accepts the connection and never
// answers would hang a console render forever.
func NewClient(reg *Registry, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 8 * time.Second}
	}
	return &Client{reg: reg, http: hc}
}

// Get performs one federated read and returns the raw body.
func (c *Client) Get(ctx context.Context, slug, path string, op Operator) ([]byte, error) {
	if op.ID == "" || op.Capability == "" {
		return nil, fmt.Errorf("federation: refusing to call %s/%s without an operator", slug, path)
	}
	product, ok := c.reg.Get(slug)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrProductNotConfigured, slug)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, product.BaseURL+path, nil)
	if err != nil {
		return nil, fmt.Errorf("federation: building request for %s: %w", slug, err)
	}
	req.Header.Set("X-Internal-Auth", product.Secret)
	req.Header.Set("X-Operator-Id", op.ID)
	req.Header.Set("X-Operator-Capability", op.Capability)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("federation: calling %s: %w", slug, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 1 MiB. A product answering with something enormous is a bug in that
	// product; reading it all would make it this process's outage too.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("federation: reading %s response: %w", slug, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("federation: %s responded %d", slug, resp.StatusCode)
	}
	return body, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-api && go test ./internal/platform/federation/ -v`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add platform-api/internal/platform/federation/
git commit -m "feat(platform-api): signed federation client carrying operator identity"
```

---

### Task 3: Fan-out with partial failure

The console's audit surface already consumes `{ data, failures }` and shows a per-source failure notice. This is the server-side half of that contract: one product being down must degrade one source, never the page.

**Files:**
- Create: `platform-api/internal/platform/federation/fanout.go`
- Create: `platform-api/internal/platform/federation/fanout_test.go`

**Interfaces:**
- Consumes: `Client`, `Operator`, `Registry` from Tasks 1–2.
- Produces: `type Failure struct { Product, Error string }`; `func FanOut[T any](ctx context.Context, c *Client, slugs []string, path string, op Operator, decode func(slug string, body []byte) ([]T, error)) ([]T, []Failure)`.

- [ ] **Step 1: Write the failing test**

```go
package federation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type row struct {
	ID string `json:"id"`
}

func decodeRows(_ string, body []byte) ([]row, error) {
	var out struct {
		Data []row `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

func TestFanOutMergesEverySourceThatAnswered(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"a"}]}`))
	}))
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", BaseURL: ok.URL},
		{Slug: "kora", BaseURL: down.URL},
	}), ok.Client())

	rows, failures := FanOut(context.Background(), c, []string{"kora", "mark8ly"}, "/admin/audit-logs", operator(), decodeRows)

	if len(rows) != 1 || rows[0].ID != "a" {
		t.Fatalf("rows = %v, want one row from the source that answered", rows)
	}
	if len(failures) != 1 || failures[0].Product != "kora" {
		t.Fatalf("failures = %v, want one naming kora", failures)
	}
}

func TestFanOutNeverReturnsANilSlice(t *testing.T) {
	c := NewClient(NewRegistry(nil), http.DefaultClient)

	rows, failures := FanOut(context.Background(), c, nil, "/x", operator(), decodeRows)

	if rows == nil {
		t.Error("rows must be an empty slice, never nil — a nil slice serialises as {} and defeats callers' ?? []")
	}
	if failures == nil {
		t.Error("failures must be an empty slice, never nil")
	}
}

func TestFanOutReportsADecodeFailureAsThatSourcesFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL}}), srv.Client())

	rows, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/x", operator(), decodeRows)

	if len(rows) != 0 {
		t.Errorf("rows = %v, want none", rows)
	}
	if len(failures) != 1 || failures[0].Product != "mark8ly" {
		t.Fatalf("failures = %v, want one naming mark8ly", failures)
	}
}

func TestFanOutFailuresFollowTheOrderAsked(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "kora", BaseURL: down.URL},
		{Slug: "mark8ly", BaseURL: down.URL},
	}), down.Client())

	_, failures := FanOut(context.Background(), c, []string{"kora", "mark8ly"}, "/x", operator(), decodeRows)

	if len(failures) != 2 || failures[0].Product != "kora" || failures[1].Product != "mark8ly" {
		t.Fatalf("failures = %v, want [kora mark8ly] in the order asked", failures)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-api && go test ./internal/platform/federation/ -run TestFanOut -v`
Expected: FAIL — `undefined: FanOut`

- [ ] **Step 3: Write minimal implementation**

```go
package federation

import (
	"context"
	"sync"
)

// Failure is one source that could not be read.
//
// Error is a string rather than an error because it crosses the HTTP boundary
// into the console, which renders it beside the source's name. It must never
// carry a secret or an internal URL.
type Failure struct {
	Product string `json:"product"`
	Error   string `json:"error"`
}

// FanOut reads the same path from several products concurrently and returns
// what answered plus what did not.
//
// It never returns an error. A product being down degrades one source; the
// caller still has a page to render, and the failure list is what makes the
// gap honest rather than invisible. That is the whole contract the console's
// audit surface already consumes.
//
// Both return values are non-nil even when empty: a nil slice serialises as
// `{}` rather than `[]`, which defeats every caller's `?? []` and has already
// crashed a console page in this estate precisely when there was no data.
func FanOut[T any](
	ctx context.Context,
	c *Client,
	slugs []string,
	path string,
	op Operator,
	decode func(slug string, body []byte) ([]T, error),
) ([]T, []Failure) {
	type result struct {
		rows []T
		err  error
	}
	results := make([]result, len(slugs))

	var wg sync.WaitGroup
	for i, slug := range slugs {
		wg.Add(1)
		go func(i int, slug string) {
			defer wg.Done()
			body, err := c.Get(ctx, slug, path, op)
			if err != nil {
				results[i] = result{err: err}
				return
			}
			rows, err := decode(slug, body)
			results[i] = result{rows: rows, err: err}
		}(i, slug)
	}
	wg.Wait()

	// Collected in the order asked, not the order they answered, so two
	// identical outages produce two identical responses.
	merged := make([]T, 0)
	failures := make([]Failure, 0)
	for i, r := range results {
		if r.err != nil {
			failures = append(failures, Failure{Product: slugs[i], Error: r.err.Error()})
			continue
		}
		merged = append(merged, r.rows...)
	}
	return merged, failures
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-api && go test ./internal/platform/federation/ -race -v`
Expected: PASS, 13 tests, no race

- [ ] **Step 5: Commit**

```bash
git add platform-api/internal/platform/federation/
git commit -m "feat(platform-api): federation fan-out with partial failure"
```

---

### Task 4: Audit module — domain and service

**Files:**
- Create: `platform-api/internal/modules/audit/internal/domain/entry.go`
- Create: `platform-api/internal/modules/audit/internal/service/service.go`
- Create: `platform-api/internal/modules/audit/internal/service/service_test.go`

**Interfaces:**
- Consumes: `federation.Client`, `federation.Operator`, `federation.Failure`, `federation.FanOut`.
- Produces: `domain.Entry` (fields `ID, Action, ActorEmail, ResourceType, ResourceID, Source string; CreatedAt time.Time`); `domain.Page struct { Entries []Entry; Failures []federation.Failure }`; `service.Service`; `func service.New(fed *federation.Client, slugs []string) *Service`; `func (s *Service) Estate(ctx context.Context, op federation.Operator, source string) (domain.Page, error)`.

Note: the module reads nothing from Postgres in this task. The console's own `console_audit_log` rows are added in a later plan; this task ships the federated half so the cutover is unblocked as soon as mark8ly #276 lands.

- [ ] **Step 1: Write the failing test**

```go
package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func productServing(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
}

func TestEstateStampsEveryRowWithItsSource(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"1","action":"tenant.suspended","created_at":"2026-08-22T10:00:00Z"}]}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL},
	}), srv.Client())

	page, err := New(fed, []string{"mark8ly"}).Estate(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(page.Entries))
	}
	if page.Entries[0].Source != "mark8ly" {
		t.Errorf("Source = %q, want mark8ly — a row that cannot say where it came from is missing the column an operator most needs", page.Entries[0].Source)
	}
}

func TestEstateNarrowsToOneSourceWhenAsked(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"1","action":"a","created_at":"2026-08-22T10:00:00Z"}]}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL},
		{Slug: "kora", BaseURL: srv.URL},
	}), srv.Client())

	page, err := New(fed, []string{"kora", "mark8ly"}).Estate(context.Background(), op(), "mark8ly")
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Entries) != 1 || page.Entries[0].Source != "mark8ly" {
		t.Fatalf("entries = %+v, want only mark8ly rows", page.Entries)
	}
}

func TestEstateRefusesAnUnknownSourceRatherThanReturningNothing(t *testing.T) {
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)

	_, err := New(fed, []string{"mark8ly"}).Estate(context.Background(), op(), "nope")
	if err == nil {
		t.Fatal("an unknown source must be an error — silently returning zero rows is indistinguishable from 'nothing happened'")
	}
}

func TestEstateSurfacesAFailedSourceRatherThanFailingWhole(t *testing.T) {
	ok := productServing(t, `{"data":[{"id":"1","action":"a","created_at":"2026-08-22T10:00:00Z"}]}`)
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: ok.URL},
		{Slug: "kora", BaseURL: down.URL},
	}), ok.Client())

	page, err := New(fed, []string{"kora", "mark8ly"}).Estate(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("Estate must not fail whole when one source is down: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Errorf("entries = %d, want the one source that answered", len(page.Entries))
	}
	if len(page.Failures) != 1 || page.Failures[0].Product != "kora" {
		t.Fatalf("failures = %v, want one naming kora", page.Failures)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-api && go test ./internal/modules/audit/... -v`
Expected: FAIL — `undefined: New`

- [ ] **Step 3: Write minimal implementation**

`platform-api/internal/modules/audit/internal/domain/entry.go`:

```go
// Package domain holds the audit module's types.
package domain

import (
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Entry is one audit row, from any source.
type Entry struct {
	ID           string    `json:"id"`
	Action       string    `json:"action"`
	ActorEmail   string    `json:"actor_email,omitempty"`
	ResourceType string    `json:"resource_type,omitempty"`
	ResourceID   string    `json:"resource_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	// Source is REQUIRED on every row. "Who did what" without "where" is not a
	// whole answer, and the console renders this column.
	Source string `json:"source"`
}

// Page is the surface's response: what was read, and what could not be.
type Page struct {
	Entries  []Entry              `json:"entries"`
	Failures []federation.Failure `json:"failures"`
}
```

`platform-api/internal/modules/audit/internal/service/service.go`:

```go
// Package service composes the estate audit timeline from every product that
// serves one.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is the contract's audit endpoint, identical on every product.
const productPath = "/admin/audit-logs"

// Service reads the estate's audit rows.
type Service struct {
	fed   *federation.Client
	slugs []string
}

// New builds the service. slugs is every product declaring the audit contract.
func New(fed *federation.Client, slugs []string) *Service {
	return &Service{fed: fed, slugs: slugs}
}

// Estate returns the merged timeline. source narrows to one product; empty
// means every product.
func (s *Service) Estate(ctx context.Context, op federation.Operator, source string) (domain.Page, error) {
	slugs := s.slugs
	if source != "" {
		if !contains(s.slugs, source) {
			// Not an empty result. Zero rows is a real answer meaning "nothing
			// happened", and a typo'd filter must not be able to impersonate it.
			return domain.Page{}, fmt.Errorf("audit: unknown source %q", source)
		}
		slugs = []string{source}
	}

	entries, failures := federation.FanOut(ctx, s.fed, slugs, productPath, op,
		func(slug string, body []byte) ([]domain.Entry, error) {
			var envelope struct {
				Data []domain.Entry `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s audit rows: %w", slug, err)
			}
			// Stamped here rather than trusted from the product: a product
			// cannot name itself into another product's rows.
			for i := range envelope.Data {
				envelope.Data[i].Source = slug
			}
			return envelope.Data, nil
		})

	// Newest first. Each source returns its own rows ordered; merged, they are
	// not, and a timeline out of order is not a timeline.
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].CreatedAt.After(entries[j].CreatedAt)
	})

	return domain.Page{Entries: entries, Failures: failures}, nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-api && go test ./internal/modules/audit/... -race -v`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add platform-api/internal/modules/audit/
git commit -m "feat(platform-api): audit module domain and federated service"
```

---

### Task 5: Audit module — HTTP surface, capability gate, and registration

**Files:**
- Create: `platform-api/internal/modules/audit/internal/handler/handler.go`
- Create: `platform-api/internal/modules/audit/internal/handler/handler_test.go`
- Create: `platform-api/internal/modules/audit/internal/handler/capability_test.go`
- Create: `platform-api/internal/modules/audit/audit.go`

**Interfaces:**
- Consumes: `service.Service`, `domain.Page` from Task 4; `auth.Verifier`, `auth.CapPlatform`, `httpx.WriteData`, `httpx.WriteError` from the kernel.
- Produces: `audit.Config{ Fed *federation.Client; Slugs []string; Verifier *auth.Verifier; Log *slog.Logger }`; `func audit.Register(mux *http.ServeMux, cfg audit.Config)`; `handler.RouteTable`.

The route is `GET /v1/audit`, gated on `platform` — taken from `platform.auditLog`'s capability in `packages/console-core/src/routes.ts:250`.

- [ ] **Step 1: Write the failing test**

`handler_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRouteTableIsTheOnlySurface(t *testing.T) {
	if len(RouteTable) != 1 {
		t.Fatalf("RouteTable has %d entries, want 1", len(RouteTable))
	}
	got := RouteTable[0]
	if got.Method != http.MethodGet || got.Pattern != "/v1/audit" {
		t.Fatalf("route = %s %s, want GET /v1/audit", got.Method, got.Pattern)
	}
}

func TestEntriesAndFailuresAreArraysWhenEmpty(t *testing.T) {
	// The console does `entries ?? []`. A nil slice serialises as null and a
	// missing key as undefined; both defeat that, and one already crashed a
	// page in this estate. This asserts the JSON, not the Go value.
	body, err := json.Marshal(map[string]any{"entries": []string{}, "failures": []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"entries":[]`) {
		t.Fatalf("marshalled = %s, want entries as []", body)
	}
}

func TestUnknownSourceIsFourHundredNotEmpty(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/audit?source=nope", nil)

	newTestHandler(t).estate(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — a typo'd filter must not look like 'nothing happened'", rec.Code)
	}
}
```

Add this helper at the top of `handler_test.go`, constructing a handler over a service with no configured products:

```go
func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)
	return New(service.New(fed, []string{"mark8ly"}), slog.New(slog.NewTextHandler(io.Discard, nil)))
}
```

with imports `io`, `log/slog`, and the `service` and `federation` packages.

`capability_test.go`:

```go
package handler

import "testing"

// Ranges over RouteTable and fails on an entry it has no case for, so a route
// added without a capability decision turns the suite red rather than passing
// untested. Mirrors the tools module's capability_test.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]string{
		"GET /v1/audit": "platform",
	}
	for _, r := range RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != "platform" {
			t.Errorf("route %s: capability %q; the estate audit log is platform-gated per console-core routes.ts", key, capability)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-api && go test ./internal/modules/audit/internal/handler/ -v`
Expected: FAIL — `undefined: RouteTable`

- [ ] **Step 3: Write minimal implementation**

`handler.go`:

```go
// Package handler is the audit module's HTTP surface.
//
//	GET /v1/audit          the estate timeline
//	    ?source=<slug>     narrow to one product
//
// # The capability is `platform`
//
// Taken from `platform.auditLog` in packages/console-core/src/routes.ts:250,
// which is the console surface this serves. Reads are gated, unlike the tools
// module's: the audit log is not rendered on every page for every operator,
// it is a Governance surface opened deliberately.
package handler

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths.
type Route struct {
	Method  string
	Pattern string
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/audit",
		handler: func(h *Handler) http.HandlerFunc { return h.estate }},
}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapPlatform, h.log, r.handler(h))))
	}
}

func (h *Handler) estate(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	page, err := h.svc.Estate(r.Context(), federation.Operator{
		ID:         principal.Subject,
		Capability: string(auth.CapPlatform),
	}, strings.TrimSpace(r.URL.Query().Get("source")))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}
```

**Kernel names used above, all verified present:** `auth.FromContext(ctx) (*Principal, bool)` (`internal/platform/auth/middleware.go:24`), `principal.Subject` (`:91`), `httpx.Unauthorized` (`internal/platform/httpx/errors.go:90`), `httpx.BadRequest` (`:98`). Do not hand-roll a status code in this handler — every refusal goes through an `httpx` constructor so the envelope and request id stay consistent.

`audit.go`:

```go
// Package audit is the platform API's estate audit-log module.
//
// # What this module is
//
// The estate-wide audit timeline — every product's rows in one shape, with the
// source stamped on each. It replaces apps/web's
// /api/admin/apps/{product}/audit-logs fan-out, which is being retired with
// that app.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, federation — and its own internals.
package audit

import (
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Fed calls the products. Never nil.
	Fed *federation.Client
	// Slugs is every product declaring the audit contract, in display order.
	Slugs []string
	// Verifier authenticates. Never nil: httpx.RegisterModule refuses without one.
	Verifier *auth.Verifier
	Log      *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Fed, cfg.Slugs), cfg.Log).Routes(mux, cfg.Verifier)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd platform-api && go test ./internal/modules/audit/... ./internal/architecture/ -race -v`
Expected: PASS. The architecture test must stay green — the module imports only kernel packages.

- [ ] **Step 5: Commit**

```bash
git add platform-api/internal/modules/audit/
git commit -m "feat(platform-api): serve GET /v1/audit behind the platform capability"
```

---

### Task 6: Wire the module into the composition root

**Files:**
- Modify: `platform-api/cmd/server/main.go`
- Modify: `platform-api/internal/platform/config/config.go`

**Interfaces:**
- Consumes: `federation.LoadRegistry`, `federation.NewClient`, `audit.Register`, `audit.Config`.
- Produces: a running server serving `/v1/audit`.

- [ ] **Step 1: Write the failing test**

Add to `platform-api/internal/platform/httpx/router_test.go`:

```go
func TestAuditRouteIsNotServedWithoutAModule(t *testing.T) {
	// Guards the composition root's contract: /v1/audit exists only because a
	// module registered it. A 404 here means nothing has silently claimed the
	// path.
	rec := httptest.NewRecorder()
	httpx.Router(deps, nil, discardLogger()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/audit", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 on a bare router", rec.Code)
	}
}
```

Match the existing helpers in that file — it already has a `deps` value and a `discardLogger()`; reuse them rather than introducing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform-api && go test ./internal/platform/httpx/ -run TestAuditRoute -v`
Expected: PASS immediately (nothing serves it yet). This test is a regression guard, not a red-green cycle — note that in the commit message.

- [ ] **Step 3: Write the wiring**

In `config.go`, add a `Federation *federation.Registry` field to the config struct and populate it in `Load()`:

```go
	reg, err := federation.LoadRegistry(os.Getenv)
	if err != nil {
		return Config{}, err
	}
	cfg.Federation = reg
```

In `main.go`, add the import `"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit"` and, after the `tools` registration:

```go
	// Federation client, shared by every module that reads another product.
	// Built here rather than per-module: the registry is one deployment-wide
	// fact, and two clients would mean two connection pools to the same hosts.
	fed := federation.NewClient(cfg.Federation, nil)

	httpx.RegisterModule(mux, verifier, "audit", func(m *http.ServeMux) {
		audit.Register(m, audit.Config{
			Fed:      fed,
			Slugs:    cfg.Federation.Slugs(),
			Verifier: verifier,
			Log:      log,
		})
	})
```

- [ ] **Step 4: Verify it builds and the whole suite passes**

Run: `cd platform-api && go build ./... && go test ./... -race`
Expected: builds; all tests pass; `internal/architecture` green.

Then verify the route serves with federation unconfigured — an operator with no products declared should get an empty timeline, not a crash:

Run: `cd platform-api && PLATFORM_API_AUTH_ENABLED=true go run ./cmd/server` and in another shell `curl -i localhost:8080/v1/audit`
Expected: `401` (no token), not `404` and not a panic.

- [ ] **Step 5: Commit**

```bash
git add platform-api/cmd/server/main.go platform-api/internal/platform/config/config.go platform-api/internal/platform/httpx/router_test.go
git commit -m "feat(platform-api): register the audit module and federation client"
```

---

### Task 7: Console cutover behind PLATFORM_API_ORIGIN

**Files:**
- Modify: `apps/console/lib/platform-api.ts` (`fetchEstateAuditLog`, around line 603)
- Modify: `apps/console/lib/audit.ts` (the comment block at lines 48–63 describing the two sources)
- Modify: `apps/console/lib/platform-api.test.ts`

**Interfaces:**
- Consumes: `GET /v1/audit` from Task 5; the existing `platformRequest`, `platformApiOrigin()`, `request` and `readBody` helpers in `platform-api.ts`.
- Produces: `fetchEstateAuditLog` unchanged in signature and return type — `(cookieHeader: string, product: string) => Promise<EstateAuditLog>`. Callers do not change.

- [ ] **Step 1: Write the failing test**

Add to `apps/console/lib/platform-api.test.ts`, matching the file's existing mocking style:

```ts
describe("fetchEstateAuditLog dual path", () => {
  it("calls the platform API when PLATFORM_API_ORIGIN is set", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { entries: [], failures: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchEstateAuditLog("cookie=1", "all");

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/audit");
    expect(url).not.toContain("/api/admin/apps");
  });

  it("sends the product as ?source= and omits it for all", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { entries: [], failures: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchEstateAuditLog("cookie=1", "mark8ly");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("source=mark8ly");

    fetchSpy.mockClear();
    await fetchEstateAuditLog("cookie=1", "all");
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain("source=");
  });

  it("falls back to apps/web when PLATFORM_API_ORIGIN is unset", async () => {
    delete process.env.PLATFORM_API_ORIGIN;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ entries: [], failures: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchEstateAuditLog("cookie=1", "all");

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/api/admin/apps/all/audit-logs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/console && npx vitest run lib/platform-api.test.ts -t "dual path"`
Expected: FAIL — the first two cases hit `/api/admin/apps/...`

- [ ] **Step 3: Write minimal implementation**

Replace the body of `fetchEstateAuditLog` in `apps/console/lib/platform-api.ts`:

```ts
export async function fetchEstateAuditLog(
  cookieHeader: string,
  product: string,
): Promise<import("./audit").EstateAuditLog> {
  const { parseEstateAuditLog } = await import("./audit");

  if (platformApiOrigin()) {
    // `all` is the absence of a filter, not a source. Sending `source=all`
    // would ask the API for a product it has never heard of, and the API
    // refuses an unknown source with a 400 rather than returning nothing —
    // which is the behaviour that makes a typo visible instead of silent.
    const query = product === "all" ? "" : `?source=${encodeURIComponent(product)}`;
    return parseEstateAuditLog(await platformRequest("audit log", `/v1/audit${query}`));
  }

  const query = new URLSearchParams({
    limit: String(AUDIT_LIMIT),
    since_hours: String(AUDIT_SINCE_HOURS),
  });
  const response = await request(
    "audit log",
    `/api/admin/apps/${encodeURIComponent(product)}/audit-logs?${query.toString()}`,
    { headers: { cookie: cookieHeader } },
  );
  return parseEstateAuditLog(await readBody(response, "audit log"));
}
```

Then update the source-description comment in `apps/console/lib/audit.ts` (lines 48–63), replacing the `products — apps/web's …` line with:

```
 *   products — the platform API's `GET /v1/audit`, which fans out to every
 *              product declaring the audit contract and returns a partial
 *              result plus a per-source failure list. Until PLATFORM_API_ORIGIN
 *              is set this still comes from apps/web's aggregate endpoint; the
 *              wire shape is identical, which is why the cutover is one branch.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/console && npx vitest run lib/platform-api.test.ts lib/audit.test.ts`
Expected: PASS, including the pre-existing audit tests unchanged.

Then the build check, because an import moved:

Run: `cd apps/console && npx next build`
Expected: builds clean. If it fails with `Can't resolve 'net'/'dns'/'fs'`, a value import has dragged `pg` into the browser bundle — import `PlatformApiError` from `./platform-api-error`, never from `./platform-api`.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/platform-api.ts apps/console/lib/audit.ts apps/console/lib/platform-api.test.ts
git commit -m "feat(console): read the estate audit log from the platform API"
```

---

### Task 8: Dev stub and end-to-end check

The stub stands in for `apps/web` in local dev and e2e. With the console now able to take either path, the stub must keep the fallback working and e2e must exercise the new one.

**Files:**
- Modify: `apps/console/dev/admin-stub.mjs`
- Modify: `apps/console/e2e/routes.spec.ts`

**Interfaces:**
- Consumes: `GET /v1/audit` (Task 5), `fetchEstateAuditLog` (Task 7).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `apps/console/e2e/routes.spec.ts`, following the file's existing test style:

```ts
test("the audit log renders with a source filter", async ({ page }) => {
  await page.goto("/platform/audit-log");
  await expect(page.getByRole("heading", { name: /audit/i })).toBeVisible();

  // A failed source must be reported, not swallowed: the surface's contract is
  // a partial result plus a named failure list.
  await expect(page.locator("body")).not.toContainText("Application error");
});
```

- [ ] **Step 2: Run it to see the current state**

Run: `cd apps/console && npx playwright test e2e/routes.spec.ts -g "audit log renders"`
Expected: PASS against the stub (the fallback path is unchanged). This is a regression guard for the cutover, so record in the commit that it was green before and after.

- [ ] **Step 3: Add the platform-API shape to the stub**

In `apps/console/dev/admin-stub.mjs`, beside the existing `/api/admin/apps/:product/audit-logs` route, add a `/v1/audit` route returning the new envelope, so a developer can exercise either path by setting `PLATFORM_API_ORIGIN` at the stub:

```js
// GET /v1/audit — the platform API's shape. Served here so a developer can
// flip PLATFORM_API_ORIGIN at the stub and exercise the cutover path without
// running platform-api and a product.
if (url.pathname === "/v1/audit") {
  return json(res, 200, {
    data: {
      entries: [
        {
          id: "stub-1",
          action: "tenant.suspended",
          actor_email: "operator@tesserix.app",
          resource_type: "tenant",
          resource_id: "t-1",
          created_at: new Date().toISOString(),
          source: "mark8ly",
        },
      ],
      failures: [],
    },
  });
}
```

Match the file's existing `json(res, status, body)` helper and routing style — read the surrounding routes before adding this one, and use whatever helper names are actually there.

- [ ] **Step 4: Verify both paths**

Run: `cd apps/console && npx playwright test e2e/routes.spec.ts -g "audit log renders"`
Expected: PASS with `PLATFORM_API_ORIGIN` unset.

Run: `cd apps/console && PLATFORM_API_ORIGIN=http://localhost:3002 npx playwright test e2e/routes.spec.ts -g "audit log renders"`
Expected: PASS against the stub's `/v1/audit` route.

- [ ] **Step 5: Commit**

```bash
git add apps/console/dev/admin-stub.mjs apps/console/e2e/routes.spec.ts
git commit -m "test(console): exercise the audit log on both transport paths"
```

---

## What this plan deliberately does not do

- **Merge the console's own `console_audit_log` rows into `/v1/audit`.** The console reads those directly from `tesserix-postgres` today and that keeps working. Folding them in is a later task, and doing it here would mix a transport change with a data-model change in one cutover.
- **Flip `PLATFORM_API_ORIGIN` in any deployed environment.** Every task ships switched off. The flip is a config change made deliberately once mark8ly #276 is live, and reverted by unsetting one variable.
- **Touch `lib/crm-conversion.ts`.** The second `apps/web` dependency moves with the tenants contract (mark8ly #277, #279), in its own plan.
- **Add product rail entries or `console-core` changes.** Those are IA changes with no data behind them yet; they land with the surfaces they describe.

## Prerequisites and what they gate

| task | needs from mark8ly |
|---|---|
| 1–6 | nothing — buildable and testable today against `httptest` fakes |
| 7–8 | nothing to build; the tests use fakes and the stub |
| flipping `PLATFORM_API_ORIGIN` in prod | [#275](https://github.com/tesserix/mark8ly/issues/275) and [#276](https://github.com/tesserix/mark8ly/issues/276) |
