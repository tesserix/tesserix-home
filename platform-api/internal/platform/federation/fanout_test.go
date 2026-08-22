package federation

import (
	"context"
	"encoding/json"
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
		{Slug: "mark8ly", BaseURL: ok.URL},
		{Slug: "kora", BaseURL: down.URL},
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

	c := NewClient(NewRegistry([]Product{{Slug: "mark8ly", BaseURL: srv.URL}}), srv.Client())

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
		{Slug: "kora", BaseURL: down.URL},
		{Slug: "mark8ly", BaseURL: down.URL},
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
		{Slug: "mark8ly", BaseURL: "http://" + addr},
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
