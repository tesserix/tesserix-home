package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

const mark8ly = "mark8ly"

// A complete funnel as mark8ly serves it today — the counters at the root,
// the nullable median, the narrower last_24h and the effective window.
const liveFunnel = `{"data":{` +
	`"started":140,"email_verified":96,"completed":61,"in_flight":22,"abandoned":57,` +
	`"median_completion_seconds":812.5,` +
	`"last_24h":{"started":9,"completed":4},` +
	`"window":{"from":"2026-08-01T00:00:00Z","to":"2026-08-30T00:00:00Z"}}}`

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func testLogger() *slog.Logger {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil))
}

// answering builds a service over one product returning the given status/body.
func answering(t *testing.T, status int, body string) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: mark8ly, BaseURL: srv.URL, Secret: "s", Endpoints: []string{"onboarding"}},
	}), srv.Client())
	return New(fed, []string{mark8ly}, testLogger())
}

func read(t *testing.T, s *Service, query url.Values) (json.RawMessage, error) {
	t.Helper()
	return s.Read(context.Background(), op(), mark8ly, query)
}

func TestReadReturnsTheProductsFunnel(t *testing.T) {
	got, err := read(t, answering(t, http.StatusOK, liveFunnel), nil)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	var funnel map[string]any
	if err := json.Unmarshal(got, &funnel); err != nil {
		t.Fatalf("funnel is not an object: %v (%s)", err, got)
	}
	if funnel["started"] != float64(140) || funnel["abandoned"] != float64(57) {
		t.Errorf("funnel = %v, want mark8ly's own counters", funnel)
	}
}

// Rule 1 of tesserix-home#404: mark8ly's stage vocabulary is rendered
// verbatim. A fixed struct here would be a second vocabulary that drifts from
// the first, and would silently drop a stage mark8ly adds later — §8.9's
// cautionary tale, where a modelled entity row dropped `sublabel` and two
// people rendered identically.
func TestReadForwardsAStageThisModuleHasNeverHeardOf(t *testing.T) {
	got, err := read(t, answering(t, http.StatusOK, `{"data":{`+
		`"started":3,"email_verified":2,"completed":1,"in_flight":1,"abandoned":0,`+
		`"payment_attached":2,`+
		`"median_completion_seconds":null,`+
		`"last_24h":{"started":1,"completed":0},`+
		`"window":{"from":"a","to":"b"}}}`), nil)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !strings.Contains(string(got), `"payment_attached":2`) {
		t.Errorf("funnel = %s, want the unknown stage carried through verbatim", got)
	}
}

// THE assertion this module exists for, half one: an unmeasurable median must
// survive as JSON null. If it ever arrives as 0 the console renders "instant
// completion" for a funnel nobody finished.
func TestReadKeepsAnUnmeasurableMedianDistinctFromZero(t *testing.T) {
	body := strings.Replace(liveFunnel, `"median_completion_seconds":812.5`,
		`"median_completion_seconds":null`, 1)
	got, err := read(t, answering(t, http.StatusOK, body), nil)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	var funnel struct {
		Median *float64 `json:"median_completion_seconds"`
	}
	if err := json.Unmarshal(got, &funnel); err != nil {
		t.Fatalf("decoding the forwarded funnel: %v", err)
	}
	if funnel.Median != nil {
		t.Fatalf("median = %v, want nil; null must not become a number", *funnel.Median)
	}
	// And the key itself must still be on the wire: an omitted key is what a
	// console-side `?? 0` turns back into "instant completion".
	if !strings.Contains(string(got), `"median_completion_seconds":null`) {
		t.Errorf("funnel = %s, want an explicit null median on the wire", got)
	}
}

// Half two: a funnel whose median key is simply absent is refused rather than
// forwarded, because absence is exactly what collapses "not measurable" into
// zero one layer down. Naming this one key is not modelling mark8ly's
// vocabulary — it is enforcing the nullability invariant the vocabulary is
// carried inside.
func TestReadRefusesAFunnelWithNoMedianKey(t *testing.T) {
	_, err := read(t, answering(t, http.StatusOK, `{"data":{`+
		`"started":3,"email_verified":2,"completed":1,"in_flight":1,"abandoned":0,`+
		`"last_24h":{"started":1,"completed":0},`+
		`"window":{"from":"a","to":"b"}}}`), nil)
	if err == nil {
		t.Fatal("expected an error for a funnel with no median key")
	}
	if !errors.Is(err, ErrUnreadable) {
		t.Errorf("err = %v, want ErrUnreadable", err)
	}
}

// "A stage with zero is a measurement; a funnel that could not be read is
// not." An empty object is indistinguishable from every stage being zero,
// which is the reading this whole module exists to prevent.
func TestReadRefusesAnEmptyFunnel(t *testing.T) {
	for name, body := range map[string]string{
		"empty object": `{"data":{}}`,
		"null data":    `{"data":null}`,
		"no data key":  `{"started":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := read(t, answering(t, http.StatusOK, body), nil); err == nil {
				t.Fatal("expected an error; an unreadable funnel must not become a readable empty one")
			}
		})
	}
}

// The dangerous inversion. Every one of these is a product failing to answer,
// and none of them may be reported as "this product has no funnel" — still
// less as a funnel of zeros.
func TestReadNeverReportsAnOutageAsAFunnel(t *testing.T) {
	for name, status := range map[string]int{
		"bad gateway":  http.StatusBadGateway,
		"server error": http.StatusInternalServerError,
		"unavailable":  http.StatusServiceUnavailable,
	} {
		t.Run(name, func(t *testing.T) {
			got, err := read(t, answering(t, status, `{"error":"boom"}`), nil)
			if err == nil {
				t.Fatal("expected an error")
			}
			if got != nil {
				t.Errorf("data = %s, want nothing renderable from a failed read", got)
			}
			for _, sentinel := range []error{ErrNoFunnel, ErrNotImplemented} {
				if errors.Is(err, sentinel) {
					t.Errorf("%d reported as %v; an outage is not a contract statement", status, sentinel)
				}
			}
		})
	}
}

// 404 and 501 are different answers and stay distinguishable, the same way
// koraaimetrics keeps them apart. 404 from a product that DECLARED
// `onboarding` is the over-declaration registry.go warns about — a permanent
// red source — and an operator debugging it needs to see which one happened.
func TestReadDistinguishes404From501(t *testing.T) {
	if _, err := read(t, answering(t, http.StatusNotFound, `{"error":"not_found"}`), nil); !errors.Is(err, ErrNoFunnel) {
		t.Errorf("404: err = %v, want ErrNoFunnel", err)
	}
	if _, err := read(t, answering(t, http.StatusNotImplemented, `{"error":"not_implemented"}`), nil); !errors.Is(err, ErrNotImplemented) {
		t.Errorf("501: err = %v, want ErrNotImplemented", err)
	}
}

func TestReadRefusesAnUnknownSource(t *testing.T) {
	s := answering(t, http.StatusOK, liveFunnel)
	if _, err := s.Read(context.Background(), op(), "nope", nil); !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
}

// "No product declares an onboarding funnel" and "this product's funnel could
// not be read" are different facts with different fixes — one is a
// FEDERATION_<SLUG>_ENDPOINTS declaration, the other is an outage.
func TestReadDistinguishesNoProductsFromAFailedRead(t *testing.T) {
	s := New(federation.NewClient(federation.NewRegistry(nil), nil), nil, testLogger())
	_, err := s.Read(context.Background(), op(), mark8ly, nil)
	if !errors.Is(err, ErrNoProducts) {
		t.Fatalf("err = %v, want ErrNoProducts", err)
	}
}

// The window is mark8ly's to interpret, not this layer's: it echoes the
// effective window back in the payload, so forwarding the parameters
// unmodified is the only way the echo stays true.
func TestReadForwardsTheWindowParameters(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.RawQuery
		_, _ = w.Write([]byte(liveFunnel))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: mark8ly, BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	s := New(fed, []string{mark8ly}, testLogger())

	q := url.Values{"created_from": {"2026-08-01T00:00:00Z"}, "created_to": {"2026-08-30T00:00:00Z"}}
	if _, err := s.Read(context.Background(), op(), mark8ly, q); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if seen != q.Encode() {
		t.Errorf("upstream query = %q, want %q", seen, q.Encode())
	}
}
