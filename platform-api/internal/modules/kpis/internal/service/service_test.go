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
		{Slug: "kora", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())
	return New(fed, []string{"kora"}, testLogger())
}

func TestReadReturnsTheWrappedMetricsMap(t *testing.T) {
	// §8.6's amendment: the map is wrapped in `data`.
	got, err := answering(t, http.StatusOK, `{"data":{"users_active":412,"foods":6421}}`).
		Read(context.Background(), op(), "kora")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got["users_active"] != float64(412) {
		t.Errorf("metrics = %v, want the product's own numbers", got)
	}
}

// A product may legitimately report a string or a bool beside its numbers.
// Narrowing to float64 would drop a metric the product meant to send.
func TestReadCarriesNonNumericScalars(t *testing.T) {
	got, _ := answering(t, http.StatusOK, `{"data":{"stage":"pre-launch","healthy":true,"n":1}}`).
		Read(context.Background(), op(), "kora")
	if got["stage"] != "pre-launch" || got["healthy"] != true {
		t.Errorf("metrics = %v, want non-numeric scalars carried", got)
	}
}

// THE case this module exists for, and it is Kora's live behaviour today:
// "kora does not report business KPIs yet".
func TestReadReportsA501AsNotInstrumented(t *testing.T) {
	_, err := answering(t, http.StatusNotImplemented, `{"error":"not_implemented","message":"no KPIs yet"}`).
		Read(context.Background(), op(), "kora")
	if !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

// 404 says the same thing one level cruder: the route is not mounted, so the
// product implements no KPIs.
func TestReadReportsA404AsNotInstrumented(t *testing.T) {
	_, err := answering(t, http.StatusNotFound, `{"error":"not_found"}`).
		Read(context.Background(), op(), "kora")
	if !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

// The dangerous mistake in the other direction: telling an operator a metric
// does not exist when it exists and is unreachable.
func TestReadDoesNotReportAnOutageAsNotInstrumented(t *testing.T) {
	for name, status := range map[string]int{
		"bad gateway":  http.StatusBadGateway,
		"server error": http.StatusInternalServerError,
		"unavailable":  http.StatusServiceUnavailable,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := answering(t, status, `{"error":"boom"}`).Read(context.Background(), op(), "kora")
			if err == nil {
				t.Fatal("expected an error")
			}
			if errors.Is(err, ErrNotInstrumented) {
				t.Errorf("%d reported as not-instrumented; an outage is not a contract statement", status)
			}
		})
	}
}

// §3.1 is explicit that `{}` is forbidden — it is indistinguishable from every
// metric being zero, which is the exact failure the status code prevents. A
// product sending it is deviating, and reporting that as "not instrumented"
// would hide the deviation behind a legitimate-looking answer.
func TestReadRefusesAnEmptyMetricsMap(t *testing.T) {
	_, err := answering(t, http.StatusOK, `{"data":{}}`).Read(context.Background(), op(), "kora")
	if err == nil {
		t.Fatal("expected an error for an empty map")
	}
	if errors.Is(err, ErrNotInstrumented) {
		t.Error("an empty map was reported as not-instrumented, hiding a §3.1 deviation")
	}
	// A sentinel, not a bare fmt.Errorf: without one the handler's switch fell
	// through to its default and called a reachable product unreachable.
	if !errors.Is(err, ErrEmptyMetrics) {
		t.Fatalf("err = %v, want ErrEmptyMetrics", err)
	}
}

// Before §8.6, §3.1 specified a bare map at the top level. Decoding that shape
// here would yield an empty map — indistinguishable from real zeroes.
func TestReadRefusesTheUnwrappedPreAmendmentShape(t *testing.T) {
	_, err := answering(t, http.StatusOK, `{"users_active":412}`).Read(context.Background(), op(), "kora")
	if err == nil {
		t.Fatal("expected an error for the pre-§8.6 bare map")
	}
}

func TestReadRefusesAnUnknownSource(t *testing.T) {
	_, err := answering(t, http.StatusOK, `{"data":{"n":1}}`).Read(context.Background(), op(), "nope")
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
}

// "No product is configured" and "this product has no metrics" are different
// facts with different fixes.
func TestReadDistinguishesNoProductsFromNoMetrics(t *testing.T) {
	s := New(federation.NewClient(federation.NewRegistry(nil), nil), nil, testLogger())
	_, err := s.Read(context.Background(), op(), "kora")
	if !errors.Is(err, ErrNoProducts) {
		t.Fatalf("err = %v, want ErrNoProducts", err)
	}
	if errors.Is(err, ErrNotInstrumented) {
		t.Error("an unconfigured deployment was reported as an uninstrumented product")
	}
}
