package federation

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
		{Slug: "mark8ly", BaseURL: ok.URL, Secret: "test-secret"},
		{Slug: "kora", BaseURL: down.URL, Secret: "test-secret"},
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

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"}}), srv.Client())

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
		{Slug: "kora", BaseURL: down.URL, Secret: "test-secret"},
		{Slug: "mark8ly", BaseURL: down.URL, Secret: "test-secret"},
	}), down.Client())

	_, failures := FanOut(context.Background(), c, []string{"kora", "mark8ly"}, "/x", operator(), decodeRows)

	if len(failures) != 2 || failures[0].Product != "kora" || failures[1].Product != "mark8ly" {
		t.Fatalf("failures = %v, want [kora mark8ly] in the order asked", failures)
	}
}

func TestFanOutFailureDoesNotLeakTheInternalURL(t *testing.T) {
	// A closed listener's address: connecting to it produces a real
	// *url.Error, which an httptest server never does.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", BaseURL: "http://" + addr, Secret: "test-secret"},
	}), &http.Client{Timeout: 2 * time.Second})

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/admin/audit-logs", operator(), decodeRows)

	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}
	if strings.Contains(failures[0].Error, addr) {
		t.Errorf("Failure.Error = %q — it leaks the internal address %q into a string the console renders in a browser", failures[0].Error, addr)
	}
	if failures[0].Error == "" {
		t.Error("Failure.Error is empty — the cause must survive sanitisation, only the URL is dropped")
	}
}

func TestFanOutFailureDoesNotLeakTheHostnameOnDNSFailure(t *testing.T) {
	const host = "mark8ly-internal.invalid"

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", BaseURL: "http://" + host + ":8080", Secret: "test-secret"},
	}), &http.Client{Timeout: 5 * time.Second})

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/admin/audit-logs", operator(), decodeRows)

	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}
	if strings.Contains(failures[0].Error, host) {
		t.Errorf("Failure.Error = %q — leaks the internal hostname into a string the console renders in a browser", failures[0].Error)
	}
	if failures[0].Error == "" {
		t.Error("Failure.Error is empty — a failure must still say something")
	}
}

// Replaces TestFanOutKeepsOurOwnErrorTextForNonTransportFailures, which
// asserted the opposite rule: that a decode failure keeps its own text. The
// decode func is CALLER-supplied, so its text is not this package's to trust —
// a caller's decode error can embed a URL of its own.
func TestFanOutDoesNotLeakTheCallersOwnDecodeErrorText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"}}), srv.Client())

	leaky := func(_ string, _ []byte) ([]row, error) {
		return nil, errors.New("boom http://secret-internal.svc:9999/x")
	}

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/x", operator(), leaky)

	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}
	if strings.Contains(failures[0].Error, "secret-internal.svc:9999") {
		t.Errorf("Failure.Error = %q — the caller's own decode error text reached the browser", failures[0].Error)
	}
	if failures[0].Error != "invalid response" {
		t.Errorf("Failure.Error = %q, want %q", failures[0].Error, "invalid response")
	}
}

func TestFanOutFailureDoesNotLeakTheURLWhenTheRequestCannotBeBuilt(t *testing.T) {
	// Control characters make http.NewRequestWithContext's URL parse fail, so
	// the failure happens before any network call and is not an ErrTransport.
	// net/url's parse error quotes the whole URL back at you.
	const host = "mark8ly-internal.svc.cluster.local"

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: "http://" + host + ":8080", Secret: "test-secret"}}), http.DefaultClient)

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/x\x7f\x01", operator(), decodeRows)

	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}
	if strings.Contains(failures[0].Error, host) {
		t.Errorf("Failure.Error = %q — leaks the internal host from a request-build failure", failures[0].Error)
	}
	if failures[0].Error != "product misconfigured" {
		t.Errorf("Failure.Error = %q, want %q", failures[0].Error, "product misconfigured")
	}
}

func TestFanOutReportsANonSuccessAsItsStatusCodeAlone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"}}), srv.Client())

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/x", operator(), decodeRows)

	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}
	if failures[0].Error != "responded 503" {
		t.Errorf("Failure.Error = %q, want %q — the status code and nothing else", failures[0].Error, "responded 503")
	}
}

func TestFanOutFailureDoesNotLeakTheAddressWhenTheBodyReadFails(t *testing.T) {
	// Promise a body, flush the headers, then kill the connection underneath
	// the client. Do() has already returned by then, so the failure happens in
	// io.ReadAll — the path *url.Error never covered.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "4096")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_ = conn.Close()
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://")

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"}}), srv.Client())

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/admin/audit-logs", operator(), decodeRows)

	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}
	if strings.Contains(failures[0].Error, host) {
		t.Errorf("Failure.Error = %q — leaks the address %q from a mid-body-read failure", failures[0].Error, host)
	}
	if failures[0].Error == "" {
		t.Error("Failure.Error is empty — a failure must still say something")
	}
}

func TestFailureKeepsTheUnredactedCauseForLoggingButNotForTheWire(t *testing.T) {
	const host = "mark8ly-internal.invalid"

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", BaseURL: "http://" + host + ":8080", Secret: "test-secret"},
	}), &http.Client{Timeout: 5 * time.Second})

	_, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/x", operator(), decodeRows)
	if len(failures) != 1 {
		t.Fatalf("failures = %v, want one", failures)
	}

	// errors.Unwrap(failures[0]) does not compile: Failure is not an error
	// (Failure.Error is a field, not a method), so Unwrap is called directly.
	// The two assertions below are what matter, not the accessor.
	cause := failures[0].Unwrap()
	if cause == nil {
		t.Fatal("cause is nil — the server-side half of the redaction trade is missing")
	}
	if !strings.Contains(cause.Error(), host) {
		t.Errorf("cause = %q, want it to still name %q so an operator can diagnose from logs", cause, host)
	}

	encoded, err := json.Marshal(failures[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), host) {
		t.Errorf("serialised Failure = %s — the cause must never reach the wire", encoded)
	}

	// The host check alone is not enough to prove the cause is unexported: an
	// error whose concrete type has only unexported fields (fmt.wrapError, as
	// here) marshals to {}, so an exported Cause would pass it while still
	// widening the wire contract — and a *net.DNSError, whose fields ARE
	// exported, would then leak the host outright. Pin the key set instead.
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire) != 2 || wire["product"] == nil || wire["error"] == nil {
		t.Errorf("serialised Failure = %s — the wire shape must be exactly {product, error}", encoded)
	}
}
