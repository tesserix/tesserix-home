package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func testLogger() *slog.Logger {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil))
}

// answering builds a service over a stub standing in for Kora, returning the
// given status/body.
func answering(t *testing.T, status int, body string) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: koraSlug, BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	return New(fed, testLogger())
}

// THE case this module exists for: the CONTENTS of Kora's `data` survive
// unparsed, including a field this package never named — the §8.9
// discipline. Only the §4.1 envelope's own `data` key is peeled off; nothing
// inside it is decoded.
func TestReadForwardsTheDataObjectUnparsed(t *testing.T) {
	inner := `{"users":[{"user_id":"u1","sublabel":"never modelled here"}]}`
	got, _, err := answering(t, http.StatusOK, `{"data":`+inner+`}`).Read(context.Background(), op(), url.Values{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got) != inner {
		t.Errorf("data = %s, want Kora's data object forwarded verbatim (%s)", got, inner)
	}
}

// Pagination is the one thing this package DOES decode, because it is the
// §4.1 contract's own fixed scalars, not anything Kora chose for this
// endpoint — decoding it is not the modelling §8.9 warns against.
func TestReadDecodesPagination(t *testing.T) {
	body := `{"data":{"n":1},"pagination":{"page":2,"limit":50,"total":137}}`
	_, pagination, err := answering(t, http.StatusOK, body).Read(context.Background(), op(), url.Values{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if pagination == nil {
		t.Fatal("pagination = nil, want the decoded block")
	}
	if pagination.Page != 2 || pagination.Limit != 50 || pagination.Total != 137 {
		t.Errorf("pagination = %+v, want {Page:2 Limit:50 Total:137}", pagination)
	}
}

// A missing pagination block is not fatal: it describes a listing, and a
// future non-listing shape at this same path could legitimately omit it.
// Losing the payload is the dangerous failure; losing the page metadata is
// not.
func TestReadToleratesAMissingPagination(t *testing.T) {
	data, pagination, err := answering(t, http.StatusOK, `{"data":{"n":1}}`).
		Read(context.Background(), op(), url.Values{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if pagination != nil {
		t.Errorf("pagination = %+v, want nil when Kora omits the block", pagination)
	}
	if string(data) != `{"n":1}` {
		t.Errorf("data = %s, want the payload still forwarded", data)
	}
}

// A missing `data` IS fatal, unlike a missing `pagination`: losing the
// payload is the failure §8.6/§4.1 exist to prevent, mirroring how kpis
// treats a missing `data` object.
func TestReadRefusesAResponseWithNoDataObject(t *testing.T) {
	for name, body := range map[string]string{
		"absent": `{"pagination":{"page":1,"limit":50,"total":0}}`,
		"null":   `{"data":null,"pagination":{"page":1,"limit":50,"total":0}}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := answering(t, http.StatusOK, body).Read(context.Background(), op(), url.Values{})
			if err == nil {
				t.Fatal("expected an error for a response with no data object")
			}
		})
	}
}

// The window and paging parameters are part of the signed canonical query —
// they must reach Kora exactly as given, not be dropped or reinterpreted.
func TestReadForwardsTheQueryString(t *testing.T) {
	var receivedQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{}}`))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: koraSlug, BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())

	query := url.Values{"from": {"2026-08-01T00:00:00Z"}, "page": {"2"}, "limit": {"50"}}
	if _, _, err := New(fed, testLogger()).Read(context.Background(), op(), query); err != nil {
		t.Fatalf("Read: %v", err)
	}

	got, err := url.ParseQuery(receivedQuery)
	if err != nil {
		t.Fatalf("kora received an unparseable query %q: %v", receivedQuery, err)
	}
	for param, want := range map[string]string{"from": "2026-08-01T00:00:00Z", "page": "2", "limit": "50"} {
		if g := got.Get(param); g != want {
			t.Errorf("kora received %s=%q, want %q", param, g, want)
		}
	}
}

// A 404 from Kora — its admin group unmounted, in practice an empty
// KORA_PLATFORM_ADMIN_SECRET — must be reported distinctly from a 501.
func TestReadReportsA404Distinctly(t *testing.T) {
	_, _, err := answering(t, http.StatusNotFound, `{"error":"not_found"}`).
		Read(context.Background(), op(), url.Values{})
	if !errors.Is(err, ErrUpstreamNotFound) {
		t.Fatalf("err = %v, want ErrUpstreamNotFound", err)
	}
	if errors.Is(err, ErrUpstreamNotImplemented) {
		t.Error("a 404 was also reported as ErrUpstreamNotImplemented — the two must stay distinct")
	}
}

// A 501 from Kora must be reported distinctly from a 404.
func TestReadReportsA501Distinctly(t *testing.T) {
	_, _, err := answering(t, http.StatusNotImplemented, `{"error":"not_implemented"}`).
		Read(context.Background(), op(), url.Values{})
	if !errors.Is(err, ErrUpstreamNotImplemented) {
		t.Fatalf("err = %v, want ErrUpstreamNotImplemented", err)
	}
	if errors.Is(err, ErrUpstreamNotFound) {
		t.Error("a 501 was also reported as ErrUpstreamNotFound — the two must stay distinct")
	}
}

// The dangerous mistake in the other direction: an outage must not be
// reported as either contract statement Kora never made.
func TestReadDoesNotReportAnOutageAsA404OrA501(t *testing.T) {
	for name, status := range map[string]int{
		"bad gateway":  http.StatusBadGateway,
		"server error": http.StatusInternalServerError,
		"unavailable":  http.StatusServiceUnavailable,
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := answering(t, status, `{"error":"boom"}`).Read(context.Background(), op(), url.Values{})
			if err == nil {
				t.Fatal("expected an error")
			}
			if errors.Is(err, ErrUpstreamNotFound) || errors.Is(err, ErrUpstreamNotImplemented) {
				t.Errorf("%d reported as a contract statement; an outage is not one", status)
			}
		})
	}
}

// "Kora is not configured on this deployment" is a deployment fact, not
// something Kora answered, and must not be confused with either upstream
// sentinel.
func TestReadReturnsErrNotConfiguredWhenKoraIsNotInTheRegistry(t *testing.T) {
	s := New(federation.NewClient(federation.NewRegistry(nil), nil), testLogger())
	_, _, err := s.Read(context.Background(), op(), url.Values{})
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
	if errors.Is(err, ErrUpstreamNotFound) || errors.Is(err, ErrUpstreamNotImplemented) {
		t.Error("an unconfigured deployment was reported as an upstream answer")
	}
}
