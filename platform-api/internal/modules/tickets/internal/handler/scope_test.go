package handler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

// byPrincipal decides WHICH gate a reply is measured against. Sending a
// machine down the operator branch would demand `respond` of it; sending an
// operator down the machine branch would drop the `respond` requirement #261
// put there.
func TestByPrincipalRoutesEachCallerToItsOwnGate(t *testing.T) {
	mark := func(who string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(who))
		})
	}

	for _, tc := range []struct {
		name  string
		roles []string
		want  string
	}{
		{"a machine takes the machine gate", []string{"product-support"}, "machine"},
		{"an operator takes the operator gate", []string{"read", "support"}, "operator"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			byPrincipal(mark("machine"), mark("operator")).
				ServeHTTP(rec, requestAs(t, operatorSubj, tc.roles...))

			if rec.Body.String() != tc.want {
				t.Errorf("routed to %q, want %q", rec.Body.String(), tc.want)
			}
		})
	}
}

func TestByPrincipalSendsAnUnauthenticatedRequestToTheOperatorGate(t *testing.T) {
	// Which then refuses it for having no principal. The machine branch must
	// never be the fallback, because it is the one with the weaker check.
	reached := ""
	rec := httptest.NewRecorder()
	byPrincipal(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = "machine" }),
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = "operator" }),
	).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/tickets", nil))

	if reached != "operator" {
		t.Errorf("an unauthenticated request reached the %q gate", reached)
	}
}
