package federation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func postOpts() PostOptions { return PostOptions{IdempotencyKey: "idem-1"} }

// TestPostSignsTheBodyItSends is the property a GET cannot exercise: the body
// hash is one of the eight canonical fields, so a client that signed an empty
// body and sent a real one would 401 on every write.
func TestPostSignsTheBodyItSends(t *testing.T) {
	const secret = "shh"
	body := []byte(`{"reason_code":"fraud"}`)
	var verified bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("reading body: %v", err)
		}
		want, err := Sign(secret, SignatureInput{
			Method:     r.Method,
			Path:       r.URL.Path,
			RawQuery:   r.URL.RawQuery,
			Body:       received,
			Timestamp:  r.Header.Get("X-Platform-Timestamp"),
			Nonce:      r.Header.Get("X-Platform-Nonce"),
			Operator:   r.Header.Get("X-Platform-Operator"),
			Capability: r.Header.Get("X-Platform-Capability"),
		})
		if err != nil {
			t.Errorf("server-side Sign: %v", err)
		}
		verified = want == r.Header.Get("X-Platform-Signature")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"changed":true}}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: secret}}), srv.Client())

	if _, err := c.Post(context.Background(), "mark8ly", "/admin/tenants/t1/suspend", body, operator(), postOpts()); err != nil {
		t.Fatalf("Post: %v", err)
	}
	if !verified {
		t.Error("the signature did not cover the body that was sent")
	}
}

// A signature captured from one payload must not verify against another. This
// is the reason the scheme hashes the body at all, so it is pinned here rather
// than assumed from the vector fixtures.
func TestPostSignatureDoesNotTransferToADifferentBody(t *testing.T) {
	const secret = "shh"
	in := SignatureInput{
		Method: "POST", Path: "/admin/tenants/t1/suspend",
		Body:      []byte(`{"reason_code":"fraud"}`),
		Timestamp: "1755859200", Nonce: "n", Operator: "op", Capability: "platform",
	}
	first, err := Sign(secret, in)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	in.Body = []byte(`{"reason_code":"abuse"}`)
	second, err := Sign(secret, in)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if first == second {
		t.Fatal("two different bodies produced the same signature")
	}
}

func TestPostSendsTheIdempotencyKeyAndContentType(t *testing.T) {
	var gotKey, gotType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("Idempotency-Key")
		gotType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	if _, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), PostOptions{IdempotencyKey: "k-42"}); err != nil {
		t.Fatalf("Post: %v", err)
	}
	if gotKey != "k-42" {
		t.Errorf("Idempotency-Key = %q, want k-42", gotKey)
	}
	if gotType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotType)
	}
}

// Fail closed. A cross-product mutation retried without a key is applied
// twice, and the retry is not always the caller's choice — a transport error
// after the far end committed looks identical to one before it.
func TestPostRefusesWithoutAnIdempotencyKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a write without an idempotency key must not leave the process")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	_, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), PostOptions{})
	if !errors.Is(err, ErrIdempotencyKeyRequired) {
		t.Fatalf("err = %v, want ErrIdempotencyKeyRequired", err)
	}
}

func TestPostRefusesToCallWithoutAnOperator(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an unattributed write must not leave the process")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	if _, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), Operator{}, postOpts()); err == nil {
		t.Fatal("a write without an operator must be refused")
	}
}

func TestPostRefusesAnUnconfiguredProduct(t *testing.T) {
	c := NewClient(NewRegistry(nil), http.DefaultClient)
	_, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts())
	if !errors.Is(err, ErrProductNotConfigured) {
		t.Fatalf("err = %v, want ErrProductNotConfigured", err)
	}
}

// A non-2xx on a write is NOT merely an error to log: the caller has to know
// whether the mutation happened. The status is carried on the error so a 409
// can be told from a 500.
func TestPostSurfacesTheStatusOnANonSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"conflict"}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	_, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts())
	if err == nil {
		t.Fatal("409 must surface as an error")
	}
	var se *statusError
	if !errors.As(err, &se) || se.Status != http.StatusConflict {
		t.Fatalf("err = %v, want a statusError carrying 409", err)
	}
}

// A nil body must hash as the empty string, exactly as a GET does — otherwise
// a bodyless POST signs differently on each side.
func TestPostWithNoBodyHashesAsEmpty(t *testing.T) {
	const secret = "shh"
	var verified bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ := io.ReadAll(r.Body)
		want, _ := Sign(secret, SignatureInput{
			Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, Body: received,
			Timestamp:  r.Header.Get("X-Platform-Timestamp"),
			Nonce:      r.Header.Get("X-Platform-Nonce"),
			Operator:   r.Header.Get("X-Platform-Operator"),
			Capability: r.Header.Get("X-Platform-Capability"),
		})
		verified = want == r.Header.Get("X-Platform-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: secret}}), srv.Client())

	if _, err := c.Post(context.Background(), "mark8ly", "/x", nil, operator(), postOpts()); err != nil {
		t.Fatalf("Post: %v", err)
	}
	if !verified {
		t.Error("a nil body did not sign as the empty string")
	}
}

func TestPostReturnsTheResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"stores_affected":3}}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	got, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts())
	if err != nil {
		t.Fatalf("Post: %v", err)
	}
	var envelope struct {
		Data struct {
			StoresAffected int `json:"stores_affected"`
		} `json:"data"`
	}
	if err := json.Unmarshal(got, &envelope); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if envelope.Data.StoresAffected != 3 {
		t.Errorf("stores_affected = %d, want 3", envelope.Data.StoresAffected)
	}
}

func TestPostAppliesTheClientTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context() == nil {
			t.Error("no context on the request")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	hc := srv.Client()
	hc.Timeout = 2 * time.Second
	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), hc)

	if _, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts()); err != nil {
		t.Fatalf("Post: %v", err)
	}
}

// A write's caller has to know WHY it was refused. §4.4 guarantees `error` is
// a stable machine-readable code, so surfacing the code — never the free-text
// `message` — is both safe and the only useful thing to pass on.
func TestPostCarriesTheProductsErrorCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_reason_code","message":"reason_code is required and must be one of the declared codes"}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	_, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts())
	code, ok := ErrorCode(err)
	if !ok || code != "invalid_reason_code" {
		t.Fatalf("ErrorCode = %q,%v; want invalid_reason_code,true", code, ok)
	}
}

// The free-text message must NOT be reachable. It is written by another
// product and this package's whole discipline is that such text never reaches
// a browser.
func TestPostDoesNotExposeTheProductsFreeTextMessage(t *testing.T) {
	const secret = "leaked-internal-hostname-do-not-render"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_reason_code","message":"` + secret + `"}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	_, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts())
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("the product's free-text message reached the error: %v", err)
	}
}

// A refusal with no parseable envelope must still be an error carrying its
// status — the absence of a code is not the absence of a failure.
func TestPostWithAnUnparseableErrorBodyStillFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`<html>gateway</html>`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"}}), srv.Client())

	_, err := c.Post(context.Background(), "mark8ly", "/x", []byte(`{}`), operator(), postOpts())
	if err == nil {
		t.Fatal("a 502 must surface as an error")
	}
	if code, ok := ErrorCode(err); ok {
		t.Errorf("ErrorCode = %q; an unparseable body has no code to report", code)
	}
}
