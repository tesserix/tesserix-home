package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

const mark8ly = "mark8ly"

// One conversion as mark8ly serves it today — `conversionResponse` in
// services/marketplace-api/internal/handlers/platformadmin/conversions.go.
const liveConversion = `{"state":"complete","ref":"tnt_01H","label":"Acme Studio",` +
	`"observed_at":"2026-09-03T02:00:00Z"}`

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "crm"}
}

func testLogger() *slog.Logger {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil))
}

// answering builds a service over one product returning the given status/body,
// and records the path it was asked for.
func answering(t *testing.T, status int, body string) (*Service, *string) {
	t.Helper()
	var asked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.RequestURI()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: mark8ly, BaseURL: srv.URL, Secret: "s", Endpoints: []string{"conversions"}},
	}), srv.Client())
	return New(fed, []string{mark8ly}, testLogger()), &asked
}

func TestForwardsTheProductsAnswerByteForByte(t *testing.T) {
	// The console's parseConversionBody is strict and already correct. A Go
	// struct here would be a second contract: the day mark8ly adds a field,
	// re-marshalling would drop it silently.
	svc, _ := answering(t, http.StatusOK, liveConversion)

	body, err := svc.Read(context.Background(), op(), mark8ly, "owner@example.com")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(body) != liveConversion {
		t.Errorf("body was rewritten\n got: %s\nwant: %s", body, liveConversion)
	}
}

func TestAsksForTheEmailItWasGiven(t *testing.T) {
	svc, asked := answering(t, http.StatusOK, liveConversion)

	// A plus and an uppercase letter: both survive a correct encoder and both
	// are mangled by string concatenation, which would silently query for a
	// different person than the operator is looking at.
	if _, err := svc.Read(context.Background(), op(), mark8ly, "A+tag@example.com"); err != nil {
		t.Fatalf("Read: %v", err)
	}
	const want = "/admin/conversions?email=A%2Btag%40example.com"
	if *asked != want {
		t.Errorf("asked for %q, want %q", *asked, want)
	}
}

func TestAnUndeclaredProductIsNotAsked(t *testing.T) {
	svc, asked := answering(t, http.StatusOK, liveConversion)

	_, err := svc.Read(context.Background(), op(), "kora", "owner@example.com")
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
	if *asked != "" {
		t.Errorf("an undeclared product was called anyway: %q", *asked)
	}
}

func TestNoProductDeclaresConversions(t *testing.T) {
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)
	svc := New(fed, nil, testLogger())

	_, err := svc.Read(context.Background(), op(), mark8ly, "owner@example.com")
	if !errors.Is(err, ErrNoProducts) {
		t.Fatalf("err = %v, want ErrNoProducts", err)
	}
}

// THE rule this module exists to keep: a failure must never reach the console
// wearing the clothes of an answer. `none` means "the product answered, and
// this person has not converted" — a merchant who IS live must never be filed
// under it because an upstream was down.
func TestNoFailureIsEverReportedAsAnAnswer(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"upstream 500", http.StatusInternalServerError, `{"error":"boom"}`},
		{"route not mounted", http.StatusNotFound, `{"error":"not_found"}`},
		{"product declines", http.StatusNotImplemented, `{"error":"not_implemented"}`},
		{"signature rejected", http.StatusUnauthorized, `{"error":"unauthenticated"}`},
		{"a 200 that is not JSON", http.StatusOK, `<html>gateway</html>`},
		{"a 200 that is not an object", http.StatusOK, `["complete"]`},
		{"a 200 with no state", http.StatusOK, `{"observed_at":"2026-09-03T02:00:00Z"}`},
		{"a 200 with an invented state", http.StatusOK, `{"state":"maybe","observed_at":"x"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := answering(t, tc.status, tc.body)

			body, err := svc.Read(context.Background(), op(), mark8ly, "owner@example.com")
			if err == nil {
				t.Fatalf("no error; body reached the caller as %s", body)
			}
			if bytes.Contains(body, []byte(`"state"`)) {
				t.Errorf("a failure carried a state to the caller: %s", body)
			}
		})
	}
}

// A miss is a definite answer, not an absence — mark8ly returns 200
// {"state":"none"} rather than 404 for exactly this reason, and this layer
// must not undo that by treating a bodyless-looking answer as a failure.
func TestAMissIsAnAnswer(t *testing.T) {
	svc, _ := answering(t, http.StatusOK,
		`{"state":"none","observed_at":"2026-09-03T02:00:00Z"}`)

	body, err := svc.Read(context.Background(), op(), mark8ly, "nobody@example.com")
	if err != nil {
		t.Fatalf("a miss was reported as a failure: %v", err)
	}
	if !bytes.Contains(body, []byte(`"state":"none"`)) {
		t.Errorf("body = %s", body)
	}
}
