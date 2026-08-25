package federation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func operator() Operator { return Operator{ID: "op-1", Capability: "platform"} }

// TestGetSignsTheRequestTheWayTheServerVerifiesIt is the end-to-end proof
// that #334 is closed, and it is deliberately not a golden-value assertion.
//
// The handler recomputes the signature from ITS OWN view of the request —
// URL.Path, URL.RawQuery, the received headers — exactly as mark8ly's
// RequirePlatformAuth does, using the same canonicaliser the golden vectors
// pin. A test that compared our header against a hardcoded hex string would
// pass just as happily if we signed the wire-form path; this one fails,
// because the server's URL.Path is the decoded form.
func TestGetSignsTheRequestTheWayTheServerVerifiesIt(t *testing.T) {
	const secret = "shh"
	var verified bool
	var gotOperator, gotCapability, gotTimestamp, gotNonce string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOperator = r.Header.Get("X-Platform-Operator")
		gotCapability = r.Header.Get("X-Platform-Capability")
		gotTimestamp = r.Header.Get("X-Platform-Timestamp")
		gotNonce = r.Header.Get("X-Platform-Nonce")

		want, err := Sign(secret, SignatureInput{
			Method:     r.Method,
			Path:       r.URL.Path,
			RawQuery:   r.URL.RawQuery,
			Timestamp:  gotTimestamp,
			Nonce:      gotNonce,
			Operator:   gotOperator,
			Capability: gotCapability,
		})
		if err != nil {
			t.Errorf("server-side Sign: %v", err)
		}
		verified = want != "" && want == r.Header.Get("X-Platform-Signature")

		// The scheme replaced these three. Their presence would mean a
		// half-migrated client shipping a secret in a header.
		for _, stale := range []string{"X-Internal-Auth", "X-Operator-Id", "X-Operator-Capability"} {
			if v := r.Header.Get(stale); v != "" {
				t.Errorf("%s is still being sent (%q); the signed scheme replaced it", stale, v)
			}
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: secret}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs?limit=200&since_hours=720", operator()); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !verified {
		t.Error("the presented signature did not verify against the request the server received")
	}
	if gotOperator != "op-1" {
		t.Errorf("X-Platform-Operator = %q, want op-1", gotOperator)
	}
	if gotCapability != "platform" {
		t.Errorf("X-Platform-Capability = %q, want platform", gotCapability)
	}
	if gotNonce == "" {
		t.Error("X-Platform-Nonce is empty; the far end refuses a request without one")
	}
	if _, err := strconv.ParseUint(gotTimestamp, 10, 64); err != nil {
		t.Errorf("X-Platform-Timestamp = %q, want unsigned decimal seconds: %v", gotTimestamp, err)
	}
}

// TestGetSignsTheDecodedPath is trap #1 from the scheme, isolated. The
// caller passes a percent-encoded path; the far end signs what net/http
// decoded. Signing the caller's string instead 401s every encoded path in
// production while every test that only checks "a signature was sent" stays
// green.
func TestGetSignsTheDecodedPath(t *testing.T) {
	const secret = "shh"
	var signedDecoded bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/tenants/t one" {
			t.Errorf("server saw path %q, want the decoded form", r.URL.Path)
		}
		want, err := Sign(secret, SignatureInput{
			Method:     r.Method,
			Path:       r.URL.Path,
			RawQuery:   r.URL.RawQuery,
			Timestamp:  r.Header.Get("X-Platform-Timestamp"),
			Nonce:      r.Header.Get("X-Platform-Nonce"),
			Operator:   r.Header.Get("X-Platform-Operator"),
			Capability: r.Header.Get("X-Platform-Capability"),
		})
		if err != nil {
			t.Errorf("server-side Sign: %v", err)
		}
		signedDecoded = want == r.Header.Get("X-Platform-Signature")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: secret}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/admin/tenants/t%20one", operator()); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !signedDecoded {
		t.Error("the client signed the wire-form path; the far end signs the decoded one")
	}
}

// TestGetSendsAFreshNonceEachCall pins the replay defence from our side. The
// far end claims each nonce single-use, so a client that reused one would
// succeed exactly once per process and then 401 forever.
func TestGetSendsAFreshNonceEachCall(t *testing.T) {
	seen := make(map[string]int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen[r.Header.Get("X-Platform-Nonce")]++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "shh"}}), srv.Client())
	for range 3 {
		if _, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", operator()); err != nil {
			t.Fatalf("Get: %v", err)
		}
	}
	if len(seen) != 3 {
		t.Errorf("got %d distinct nonces across 3 calls, want 3", len(seen))
	}
}

// TestGetRefusesWhenTheRequestCannotBeSigned covers the fail-closed path: an
// empty secret must not produce a valid-looking HMAC, and the request must
// not leave the process. LoadRegistry refuses to boot without a secret, so
// this state is only reachable through a hand-built Registry — which is
// exactly what every test in this package does.
func TestGetRefusesWhenTheRequestCannotBeSigned(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an unsigned request must not leave the process")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: ""}}), srv.Client())

	_, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", operator())
	if !errors.Is(err, ErrSigning) {
		t.Fatalf("err = %v, want ErrSigning", err)
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

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", Operator{}); err == nil {
		t.Fatal("an anonymous federated call must be refused, not sent")
	}
}

func TestGetTurnsANonSuccessIntoAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"}}), srv.Client())

	if _, err := c.Get(context.Background(), "mark8ly", "/x", operator()); err == nil {
		t.Fatal("503 must surface as an error, not as an empty success")
	}
}

// TestGetReproducesAGoldenVectorEndToEnd pins the whole client path — base
// URL joining, request building, path decoding, timestamp formatting, header
// naming — against a signature mark8ly published, not one we computed.
//
// signature_test.go proves the canonicaliser matches theirs; this proves
// Client.Get feeds it the right things. The two are separable failures: a
// client that signed req.URL.EscapedPath() would pass every test in
// signature_test.go and 401 in production.
//
// It is the only test that pins now and nonce. Everything else lets the real
// ones run, because a fixed nonce would hide a client that never rotates it.
func TestGetReproducesAGoldenVectorEndToEnd(t *testing.T) {
	var want vector
	for _, v := range loadVectors(t) {
		if v.Name == "get-with-query" {
			want = v
		}
	}
	if want.Name == "" {
		t.Fatal(`vector "get-with-query" is missing from testdata/vectors.json`)
	}

	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-Platform-Signature")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	ts, err := strconv.ParseInt(want.Timestamp, 10, 64)
	if err != nil {
		t.Fatalf("vector timestamp: %v", err)
	}

	// The base URL carries the /api/v1/platform prefix the vector's path
	// includes — and that mark8ly's routes.go requires for a reason that has
	// nothing to do with signing. See registry.go.
	c := NewClient(NewRegistry([]Product{{
		Slug:    "mark8ly",
		BaseURL: srv.URL + "/api/v1/platform",
		Secret:  want.Secret,
	}}), srv.Client())
	c.now = func() time.Time { return time.Unix(ts, 0) }
	c.nonce = func() (string, error) { return want.Nonce, nil }

	op := Operator{ID: want.Operator, Capability: want.Capability}
	if _, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs?since_hours=720&limit=200", op); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != want.Signature {
		t.Errorf("X-Platform-Signature = %q, want the published vector %q", got, want.Signature)
	}
}
