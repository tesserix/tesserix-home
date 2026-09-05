package handler

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

// DB-free by design: the module's database tests skip without
// TESSERIX_TEST_DB_*, and the rules below decide who may read a product's
// broadcasts. A gate whose tests only run where postgres is configured is not
// a gate anybody is checking.

const (
	testProject = "386377618200461939"
	tokenShaped = "a.b.c"
	machineSubj = "machine-subject-1"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) { return s.claims, nil }

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func muxFor(t *testing.T, reg *productscope.Registry, roles ...string) *http.ServeMux {
	t.Helper()
	verifier := auth.NewVerifier(stubParser{claims: &auth.Claims{
		Subject:   machineSubj,
		ClientID:  "some-client",
		Audience:  []string{testProject},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(30 * time.Minute),
		Roles:     roles,
	}}, testProject)

	mux := http.NewServeMux()
	New(nil, discardLog(), reg).Routes(mux, verifier)
	return mux
}

func get(t *testing.T, mux *http.ServeMux, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+tokenShaped)
	rec := httptest.NewRecorder()
	// A refusal is reached before the service; anything that got past would
	// panic on the nil service, which is not what is asserted.
	func() {
		defer func() { _ = recover() }()
		mux.ServeHTTP(rec, req)
	}()
	return rec
}

func mapped(t *testing.T) *productscope.Registry {
	t.Helper()
	return productscope.NewRegistry(map[string]string{machineSubj: "mark8ly"})
}

func TestTheRouteNeedsItsOwnCapability(t *testing.T) {
	// product-support is a DIFFERENT grant. A support caller reading every
	// broadcast is exactly the widening the separate capability prevents.
	rec := get(t, muxFor(t, mapped(t), "product-support"), "/v1/announcements")

	if rec.Code != http.StatusForbidden {
		t.Errorf("a product-support caller got %d, want 403", rec.Code)
	}
}

func TestAnOperatorSurfaceDoesNotOpenIt(t *testing.T) {
	rec := get(t, muxFor(t, mapped(t), "read", "support", "platform"), "/v1/announcements")

	if rec.Code != http.StatusForbidden {
		t.Errorf("an operator got %d, want 403 — this route serves products", rec.Code)
	}
}

func TestAHolderReachesTheHandler(t *testing.T) {
	rec := get(t, muxFor(t, mapped(t), "read-announcements"), "/v1/announcements")

	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Errorf("a read-announcements caller was refused with %d", rec.Code)
	}
}

// The same rule the tickets module learned in production: an unmapped machine
// is REFUSED, and with a 403 rather than a fault. Serving it "everything
// untargeted" would be a different answer wearing the same shape.
func TestAnUnmappedMachineIsRefusedWithA403(t *testing.T) {
	rec := get(t, muxFor(t, productscope.NewRegistry(nil), "read-announcements"), "/v1/announcements")

	if rec.Code == http.StatusInternalServerError {
		t.Fatal("an unmapped machine got a 500 — a configuration refusal must not present as a fault")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("got %d, want 403", rec.Code)
	}
}

func TestANilRegistryRefusesRatherThanServing(t *testing.T) {
	rec := get(t, muxFor(t, nil, "read-announcements"), "/v1/announcements")

	if rec.Code != http.StatusForbidden {
		t.Errorf("a nil registry gave %d, want 403", rec.Code)
	}
}

// There is no `product` parameter, and that is the containment: a caller
// cannot ask about an audience it is not in.
func TestAProductParameterIsRejectedRatherThanHonoured(t *testing.T) {
	rec := get(t, muxFor(t, mapped(t), "read-announcements"), "/v1/announcements?product=kora")

	if rec.Code == http.StatusOK {
		t.Error("a product parameter was accepted — the product must come from the scope")
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("got %d, want 400 naming the unknown parameter", rec.Code)
	}
}
