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
