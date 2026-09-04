package handler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

// These tests deliberately need NO database. The module's DB-backed tests skip
// when TESSERIX_TEST_DB_* is unset, and scopeFor is where #152's containment is
// decided — a rule whose tests only run on a machine with postgres is a rule
// nobody is checking.

const (
	testProject  = "386377618200461939"
	testConsole  = "386382971877196703"
	tokenShaped  = "a.b.c"
	machineSubj  = "machine-subject-1"
	operatorSubj = "operator-subject-1"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) { return s.claims, nil }

func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// requestAs runs a request through Authenticate so the principal reaches the
// context the way it does in production, then hands back the authenticated
// request for scopeFor to read.
func requestAs(t *testing.T, subject string, roles ...string) *http.Request {
	t.Helper()

	verifier := auth.NewVerifier(stubParser{claims: &auth.Claims{
		Subject:   subject,
		ClientID:  testConsole,
		Audience:  []string{testProject},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     roles,
	}}, testProject)

	var captured *http.Request
	h := auth.Authenticate(verifier, discardLog(), http.HandlerFunc(
		func(_ http.ResponseWriter, r *http.Request) { captured = r }))

	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	h.ServeHTTP(httptest.NewRecorder(), req)

	if captured == nil {
		t.Fatal("the request was not authenticated — the stub verifier is misconfigured")
	}
	return captured
}

func registry(t *testing.T, subject, product string) *productscope.Registry {
	t.Helper()
	return productscope.NewRegistry(map[string]string{subject: product})
}

func TestAMappedMachineIsConfinedToItsProduct(t *testing.T) {
	h := &Handler{log: discardLog(), scope: registry(t, machineSubj, "mark8ly")}

	got, err := h.scopeFor(requestAs(t, machineSubj, "product-support"))
	if err != nil {
		t.Fatalf("scopeFor: %v", err)
	}
	if got.ProductID != "mark8ly" {
		t.Errorf("ProductID = %q, want mark8ly", got.ProductID)
	}
}

// The dangerous default, and the reason scopeFor exists as a named function
// rather than an inline lookup: Scope's zero value means THE ESTATE, so
// falling through to it here would turn one missing config line into
// estate-wide ticket access for a product's machine.
func TestAProductSupportCallerWithNoRegistryEntryIsRefused(t *testing.T) {
	h := &Handler{log: discardLog(), scope: productscope.NewRegistry(nil)}

	got, err := h.scopeFor(requestAs(t, machineSubj, "product-support"))
	if err == nil {
		t.Fatalf("an unmapped product-support caller was admitted with scope %+v", got)
	}
	if !errors.Is(err, errUnscopedMachine) {
		t.Errorf("want errUnscopedMachine, got %v", err)
	}
}

func TestANilRegistryRefusesAMachineRatherThanAdmittingItUnscoped(t *testing.T) {
	// A deployment that forgot to wire the registry must lose the product
	// path, not hand it the estate.
	h := &Handler{log: discardLog(), scope: nil}

	if _, err := h.scopeFor(requestAs(t, machineSubj, "product-support")); err == nil {
		t.Fatal("a nil registry admitted a machine caller")
	}
}

func TestAnOperatorIsUnscoped(t *testing.T) {
	// Unchanged by #152: a human on the support surface sees the estate.
	h := &Handler{log: discardLog(), scope: registry(t, machineSubj, "mark8ly")}

	got, err := h.scopeFor(requestAs(t, operatorSubj, "read", "support"))
	if err != nil {
		t.Fatalf("scopeFor: %v", err)
	}
	if !got.Unscoped() {
		t.Errorf("an operator was scoped to %q", got.ProductID)
	}
}

// Registry BEFORE capability. A subject named in the registry is a product's
// machine and stays confined whatever else its token carries — otherwise
// acquiring an operator capability would be a way out of the scope.
func TestARegisteredSubjectStaysScopedEvenHoldingTheOperatorSurface(t *testing.T) {
	h := &Handler{log: discardLog(), scope: registry(t, machineSubj, "mark8ly")}

	got, err := h.scopeFor(requestAs(t, machineSubj, "support", "product-support"))
	if err != nil {
		t.Fatalf("scopeFor: %v", err)
	}
	if got.ProductID != "mark8ly" {
		t.Errorf("ProductID = %q, want mark8ly — the registry must win", got.ProductID)
	}
}

func TestScopeForRefusesARequestThatWasNeverAuthenticated(t *testing.T) {
	h := &Handler{log: discardLog(), scope: productscope.NewRegistry(nil)}

	_, err := h.scopeFor(httptest.NewRequest(http.MethodGet, "/v1/tickets", nil))
	if !errors.Is(err, errNoPrincipal) {
		t.Errorf("want errNoPrincipal, got %v", err)
	}
}

// The reads it IS allowed reach the handler, so the refusal above is about the
// reply route specifically and not about machines being locked out generally.
func TestAMachineIsAdmittedToTheReadRoutes(t *testing.T) {
	verifier := auth.NewVerifier(stubParser{claims: &auth.Claims{
		Subject:   machineSubj,
		ClientID:  "some-machine-client",
		Audience:  []string{testProject},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     []string{"product-support"},
	}}, testProject)

	mux := http.NewServeMux()
	(&Handler{log: discardLog(), scope: registry(t, machineSubj, "mark8ly")}).Routes(mux, verifier)

	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()

	// The capability gate is what is under test. It passes the request to a
	// handler with no pool behind it, so anything other than 401/403 means the
	// gate admitted the caller, which is the assertion.
	func() {
		defer func() { _ = recover() }()
		mux.ServeHTTP(rec, req)
	}()

	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Errorf("a product-support machine was refused a READ with %d", rec.Code)
	}
}

// The reply route is OPEN to a machine now, and the guard moved rather than
// disappeared: it used to be the capability gate, and it is now the author.
//
// This replaced a test that refused machines outright, which existed so that
// reopening the route could not happen by accident. It did its job — it failed
// when this change reopened it.
//
// What is asserted HERE is only what a request can reach without a pool: the
// capability gate admits a machine, and the tenant requirement refuses one
// that names no tenant. The AUTHOR contract is decided inside service.Reply,
// so it is proved by the eight pure tests on authorFor in the service package
// rather than restated here against a nil service, where a recovered panic
// would read as a passing refusal.
func TestAMachineReachesTheReplyRouteAndIsRefusedWithoutATenant(t *testing.T) {
	rec := post(t, machineMux(t), `{"content":"hello"}`)

	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Fatalf("the capability gate refused a machine with %d — the route should be open to it now", rec.Code)
	}
	if rec.Code < 400 {
		t.Errorf("a reply naming no tenant was accepted (%d)", rec.Code)
	}
}

// tenantA/tenantB are the service package's fixtures; repeated here because
// the two packages do not share test helpers.
const (
	tenantA    = "3f2a1c94-0000-4000-8000-0000000000aa"
	ticketPath = "/v1/tickets/3f2a1c94-0000-4000-8000-000000000001/replies"
)

func machineMux(t *testing.T) *http.ServeMux {
	t.Helper()
	verifier := auth.NewVerifier(stubParser{claims: &auth.Claims{
		Subject:   machineSubj,
		ClientID:  "some-machine-client",
		Audience:  []string{testProject},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     []string{"product-support"},
	}}, testProject)

	mux := http.NewServeMux()
	(&Handler{log: discardLog(), scope: registry(t, machineSubj, "mark8ly")}).Routes(mux, verifier)
	return mux
}

func post(t *testing.T, mux *http.ServeMux, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, ticketPath, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()
	// A refusal is reached before any pool is touched; anything that got past
	// validation would panic on the nil service, which is not what is asserted.
	func() {
		defer func() { _ = recover() }()
		mux.ServeHTTP(rec, req)
	}()
	return rec
}

// The summary is operator-only: a product caller is confined to one tenant and
// the summary has no tenant dimension, so there is no honest answer for it.
func TestAMachineIsRefusedTheSummary(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets/summary", nil)
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()
	machineMux(t).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("a machine got %d on the summary, want 403", rec.Code)
	}
}

// A machine that names no tenant must not receive its product's whole estate.
// apps/web requires ?tenant_id= on every internal ticket route for exactly
// this reason.
func TestAMachineListingWithoutATenantIsRefused(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()
	func() {
		defer func() { _ = recover() }()
		machineMux(t).ServeHTTP(rec, req)
	}()

	if rec.Code < 400 {
		t.Errorf("a machine listed with no tenant and got %d — this reads every tenant in the product", rec.Code)
	}
}

// Filing is machine-only. An operator holding the whole support surface and
// its verb still has no queue of their own to file into.
func TestAnOperatorIsRefusedTheCreateRoute(t *testing.T) {
	verifier := auth.NewVerifier(stubParser{claims: &auth.Claims{
		Subject:   operatorSubj,
		ClientID:  testConsole,
		Audience:  []string{testProject},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     []string{"read", "support", "respond"},
	}}, testProject)

	mux := http.NewServeMux()
	(&Handler{log: discardLog(), scope: registry(t, machineSubj, "mark8ly")}).Routes(mux, verifier)

	req := httptest.NewRequest(http.MethodPost, "/v1/tickets", strings.NewReader(`{"subject":"x"}`))
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("an operator got %d filing a ticket, want 403", rec.Code)
	}
}

// A machine reaches the route, and is refused for naming no tenant — the same
// rule the reads follow.
func TestAMachineReachesTheCreateRouteAndNeedsATenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/tickets",
		strings.NewReader(`{"subject":"Payouts","description":"delayed"}`))
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()
	func() {
		defer func() { _ = recover() }()
		machineMux(t).ServeHTTP(rec, req)
	}()

	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Fatalf("the capability gate refused a machine with %d — filing is its route", rec.Code)
	}
	if rec.Code < 400 {
		t.Errorf("a filing naming no tenant was accepted (%d)", rec.Code)
	}
}
