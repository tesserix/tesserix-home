package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func lifecycleProduct(t *testing.T, status int, body string) (*httptest.Server, *string, *string) {
	t.Helper()
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	return srv, &gotPath, &gotBody
}

func lifecycleService(t *testing.T, srv *httptest.Server) *Service {
	t.Helper()
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	return New(fed, []string{"mark8ly"}, testLogger())
}

const okResult = `{"data":{"tenant_id":"t1","status":"suspended","stores_affected":3,"changed":true}}`

func TestSuspendCallsTheProductThatOwnsTheTenant(t *testing.T) {
	srv, path, body := lifecycleProduct(t, http.StatusOK, okResult)
	defer srv.Close()

	res, err := lifecycleService(t, srv).Suspend(context.Background(), op(),
		"mark8ly:t1", Lifecycle{ReasonCode: "fraud", Reason: "chargebacks"}, "idem-1")
	if err != nil {
		t.Fatalf("Suspend: %v", err)
	}
	// The namespaced id is split: the product is asked about ITS OWN id, not
	// the console's composite key.
	if *path != "/admin/tenants/t1/suspend" {
		t.Errorf("path = %q, want /admin/tenants/t1/suspend", *path)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(*body), &sent); err != nil {
		t.Fatalf("body: %v", err)
	}
	if sent["reason_code"] != "fraud" || sent["reason"] != "chargebacks" {
		t.Errorf("body = %v, want the reason through", sent)
	}
	if res.StoresAffected != 3 || !res.Changed {
		t.Errorf("result = %+v, want the product's own answer", res)
	}
}

func TestUnsuspendUsesItsOwnPath(t *testing.T) {
	srv, path, _ := lifecycleProduct(t, http.StatusOK, okResult)
	defer srv.Close()

	if _, err := lifecycleService(t, srv).Unsuspend(context.Background(), op(),
		"mark8ly:t1", Lifecycle{ReasonCode: "resolved"}, "idem-1"); err != nil {
		t.Fatalf("Unsuspend: %v", err)
	}
	if *path != "/admin/tenants/t1/unsuspend" {
		t.Errorf("path = %q, want /admin/tenants/t1/unsuspend", *path)
	}
}

// The id carries which product owns the tenant. A bare id names no product, so
// there is nothing to call — refused rather than guessed at, because guessing
// would mean picking a product to mutate.
func TestSuspendRefusesAnIdThatNamesNoProduct(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusOK, okResult)
	defer srv.Close()

	_, err := lifecycleService(t, srv).Suspend(context.Background(), op(), "t1",
		Lifecycle{ReasonCode: "fraud"}, "idem-1")
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
}

func TestSuspendRefusesAnIdNamingAnUnconfiguredProduct(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusOK, okResult)
	defer srv.Close()

	_, err := lifecycleService(t, srv).Suspend(context.Background(), op(), "kora:t1",
		Lifecycle{ReasonCode: "fraud"}, "idem-1")
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
}

// A product's own id may contain a colon. Splitting on the last separator
// would call the wrong path.
func TestSuspendSplitsOnTheFirstSeparatorOnly(t *testing.T) {
	srv, path, _ := lifecycleProduct(t, http.StatusOK, okResult)
	defer srv.Close()

	if _, err := lifecycleService(t, srv).Suspend(context.Background(), op(),
		"mark8ly:store:42", Lifecycle{ReasonCode: "fraud"}, "idem-1"); err != nil {
		t.Fatalf("Suspend: %v", err)
	}
	if *path != "/admin/tenants/store:42/suspend" {
		t.Errorf("path = %q, want the product id kept whole", *path)
	}
}

// The product's §4.4 code is what tells an operator why. Losing it leaves
// "responded 400", which is not actionable on a form.
func TestSuspendSurfacesTheProductsRefusalCode(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusBadRequest,
		`{"error":"invalid_reason_code","message":"must be one of the declared codes"}`)
	defer srv.Close()

	_, err := lifecycleService(t, srv).Suspend(context.Background(), op(), "mark8ly:t1",
		Lifecycle{ReasonCode: "nope"}, "idem-1")
	if err == nil {
		t.Fatal("a 400 must surface as an error")
	}
	code, ok := federation.ErrorCode(err)
	if !ok || code != "invalid_reason_code" {
		t.Errorf("ErrorCode = %q,%v; want invalid_reason_code,true", code, ok)
	}
}

// Client.Post refuses without one, and a mutating call retried without a key
// is applied twice.
func TestSuspendRequiresAnIdempotencyKey(t *testing.T) {
	srv, _, _ := lifecycleProduct(t, http.StatusOK, okResult)
	defer srv.Close()

	if _, err := lifecycleService(t, srv).Suspend(context.Background(), op(),
		"mark8ly:t1", Lifecycle{ReasonCode: "fraud"}, ""); err == nil {
		t.Fatal("a write without an idempotency key must be refused")
	}
}

func TestSuspendForwardsTheIdempotencyKey(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("Idempotency-Key")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(okResult))
	}))
	defer srv.Close()

	if _, err := lifecycleService(t, srv).Suspend(context.Background(), op(),
		"mark8ly:t1", Lifecycle{ReasonCode: "fraud"}, "idem-42"); err != nil {
		t.Fatalf("Suspend: %v", err)
	}
	if gotKey != "idem-42" {
		t.Errorf("Idempotency-Key = %q, want idem-42", gotKey)
	}
}
