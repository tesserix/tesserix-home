package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(service.New(fed, []string{"mark8ly"}, log), log)
}

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
	if strings.Contains(rec.Body.String(), "entries") {
		t.Fatalf("body = %s, want no entries key on an error response", rec.Body.String())
	}
}
