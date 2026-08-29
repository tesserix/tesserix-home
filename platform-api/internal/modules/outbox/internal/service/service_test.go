package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func testLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

func productServing(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
}

// TestEstateMergesTwoProductsAndStampsEverySource covers the first required
// case: two products both returning rows merge into one page, and every row
// carries the source it came from.
func TestEstateMergesTwoProductsAndStampsEverySource(t *testing.T) {
	mark8ly := productServing(t, `{"data":[{"id":"1","tenant_id":"t1","aggregate":"order","aggregate_id":"o1","event_type":"order.created","status":"published","created_at":"2026-08-22T10:00:00Z","published_at":"2026-08-22T10:00:05Z"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer mark8ly.Close()
	kora := productServing(t, `{"data":[{"id":"2","tenant_id":"t2","aggregate":"food","aggregate_id":"f1","event_type":"food.updated","status":"failed","created_at":"2026-08-22T09:00:00Z","error":"delivery_failed"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer kora.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: mark8ly.URL, Secret: "test-secret"},
		{Slug: "kora", BaseURL: kora.URL, Secret: "test-secret"},
	}), http.DefaultClient)

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Events) != 2 {
		t.Fatalf("events = %d, want 2", len(page.Events))
	}

	bySource := map[string]domain.Event{}
	for _, e := range page.Events {
		bySource[e.Source] = e
	}
	if _, ok := bySource["mark8ly"]; !ok {
		t.Errorf("no event stamped with source mark8ly: %+v", page.Events)
	}
	if _, ok := bySource["kora"]; !ok {
		t.Errorf("no event stamped with source kora: %+v", page.Events)
	}
	if len(page.Failures) != 0 {
		t.Errorf("failures = %v, want none — both products answered", page.Failures)
	}
	if len(page.NotImplemented) != 0 {
		t.Errorf("not_implemented = %v, want none", page.NotImplemented)
	}
}

// TestEstateSurfacesAFailedSourceRatherThanFailingWhole covers the second
// required case: one product failing must not take the other's rows down
// with it, and the failure is reported as a named degraded source.
func TestEstateSurfacesAFailedSourceRatherThanFailingWhole(t *testing.T) {
	ok := productServing(t, `{"data":[{"id":"1","tenant_id":"t1","aggregate":"order","aggregate_id":"o1","event_type":"order.created","status":"pending","created_at":"2026-08-22T10:00:00Z"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: ok.URL, Secret: "test-secret"},
		{Slug: "kora", BaseURL: down.URL, Secret: "test-secret"},
	}), http.DefaultClient)

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate must not fail whole when one source is down: %v", err)
	}
	if len(page.Events) != 1 {
		t.Errorf("events = %d, want the one source that answered", len(page.Events))
	}
	if len(page.Failures) != 1 || page.Failures[0].Source != "kora" {
		t.Fatalf("failures = %v, want one naming kora", page.Failures)
	}
	if len(page.NotImplemented) != 0 {
		t.Errorf("not_implemented = %v, want none — a 502 is a real failure, not a contract statement", page.NotImplemented)
	}
}

// TestEstateReportsA501AsNotImplementedRatherThanAFailure covers the third
// required case: a product answering 501 has made a contract statement, and
// must not be reported as a failed source.
func TestEstateReportsA501AsNotImplementedRatherThanAFailure(t *testing.T) {
	ok := productServing(t, `{"data":[{"id":"1","tenant_id":"t1","aggregate":"order","aggregate_id":"o1","event_type":"order.created","status":"pending","created_at":"2026-08-22T10:00:00Z"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer ok.Close()
	notImplemented := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write([]byte(`{"error":"not_implemented","message":"kora does not track an outbox"}`))
	}))
	defer notImplemented.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: ok.URL, Secret: "test-secret"},
		{Slug: "kora", BaseURL: notImplemented.URL, Secret: "test-secret"},
	}), http.DefaultClient)

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate must not fail whole when one source answers 501: %v", err)
	}
	if len(page.Events) != 1 {
		t.Errorf("events = %d, want the one source that answered rows", len(page.Events))
	}
	if len(page.Failures) != 0 {
		t.Fatalf("failures = %v, want none — a 501 is a contract statement, not an error", page.Failures)
	}
	if len(page.NotImplemented) != 1 || page.NotImplemented[0] != "kora" {
		t.Fatalf("not_implemented = %v, want exactly [kora]", page.NotImplemented)
	}
}

// TestEstateAnswersEmptyWithNoPanicWhenNoSlugsAreConfigured covers the
// fourth required case, and the one that matters most operationally: it is
// exactly what SlugsImplementing("outbox") returns in production today,
// before FEDERATION_MARK8LY_ENDPOINTS names outbox. The console must be able
// to tell this apart from a genuinely empty outbox, which is why this is an
// error (mapped to 501 by the handler) rather than a silent 200 — the same
// distinction the audit and inbox modules draw for the same reason.
func TestEstateAnswersEmptyWithNoPanicWhenNoSlugsAreConfigured(t *testing.T) {
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)

	log, _ := testLogger()
	page, err := New(fed, nil, log).Estate(context.Background(), op(), Query{})
	if !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented — an unconfigured registry must not answer like a quiet outbox", err)
	}
	if len(page.Events) != 0 || len(page.Failures) != 0 || len(page.NotImplemented) != 0 {
		t.Fatalf("page = %+v, want the zero value", page)
	}
}

// TestEstateLogsTheUnredactedCauseOfARealFailure proves the service calls
// Failure.Unwrap() and logs the real cause for a genuine failure, and proves
// the mirror image: a 501 is not logged as an error at all, because it is
// not one.
func TestEstateLogsTheUnredactedCauseOfARealFailure(t *testing.T) {
	unreachable := "127.0.0.1:1"

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: "http://" + unreachable, Secret: "test-secret"},
	}), &http.Client{})

	log, buf := testLogger()
	page, err := New(fed, []string{"kora"}, log).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate must not fail whole when one source is down: %v", err)
	}
	if len(page.Failures) != 1 {
		t.Fatalf("failures = %v, want one naming kora", page.Failures)
	}

	sanitized := page.Failures[0].Message
	logged := buf.String()

	if strings.Contains(sanitized, unreachable) {
		t.Fatalf("sanitized Failure.Message leaked the host: %q", sanitized)
	}
	if !strings.Contains(logged, unreachable) && !strings.Contains(logged, "connection refused") {
		t.Fatalf("log output = %q, want the unredacted cause (host %q or \"connection refused\")", logged, unreachable)
	}
}

// TestEstateNamespacesEveryRowIdWithItsSource guards against two products'
// rows colliding in a merged list keyed by id, mirroring the audit and inbox
// modules' regression guard for the same failure mode.
func TestEstateNamespacesEveryRowIdWithItsSource(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"12","tenant_id":"t1","aggregate":"order","aggregate_id":"o1","event_type":"order.created","status":"pending","created_at":"2026-08-22T10:00:00Z"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Events) != 1 {
		t.Fatalf("events = %d, want 1", len(page.Events))
	}
	if got := page.Events[0].ID; got != "mark8ly:12" {
		t.Errorf("ID = %q, want %q", got, "mark8ly:12")
	}
}

// TestEstateOverridesTheSourceAProductClaimsForAnother is the adversarial
// half: the slug the call was made to wins over anything the body says.
func TestEstateOverridesTheSourceAProductClaimsForAnother(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"9f2","source":"mark8ly","tenant_id":"t1","aggregate":"order","aggregate_id":"o1","event_type":"order.created","status":"pending","created_at":"2026-08-22T10:00:00Z"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora"}, log).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Events) != 1 {
		t.Fatalf("events = %d, want 1", len(page.Events))
	}
	if got := page.Events[0].Source; got != "kora" {
		t.Errorf("Source = %q, want kora", got)
	}
}

// TestEstateForwardsEveryAcceptedFilterToEachProduct proves the six pinned
// query parameters reach the product request untouched.
func TestEstateForwardsEveryAcceptedFilterToEachProduct(t *testing.T) {
	asked := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		_, _ = w.Write([]byte(`{"data":[],"pagination":{"page":1,"limit":50,"total":0}}`))
	}))
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	olderThan, sinceHours, page, limit := 60, 24, 2, 50
	log, _ := testLogger()
	_, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), Query{
		Status:           "failed",
		EventType:        "order.created",
		OlderThanMinutes: &olderThan,
		SinceHours:       &sinceHours,
		TenantID:         "11111111-1111-1111-1111-111111111111",
		Page:             &page,
		Limit:            &limit,
	})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}

	got := <-asked
	if !strings.HasPrefix(got, "/admin/outbox?") {
		t.Fatalf("path = %q, want the contract's endpoint", got)
	}
	for _, want := range []string{
		"status=failed", "event_type=order.created", "older_than_minutes=60",
		"since_hours=24", "tenant_id=11111111-1111-1111-1111-111111111111",
		"page=2", "limit=50",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("path = %q, missing %q", got, want)
		}
	}
}

// TestPageMarshalsTheShapeExpected pins the wire shape's key set, the same
// discipline the audit module applies to protect the console's parser from
// a silent rename.
func TestPageMarshalsTheShapeExpected(t *testing.T) {
	age := int64(120)
	published := "2026-08-22T10:05:00Z"
	errMsg := "delivery_failed"
	page := domain.Page{
		Events: []domain.Event{
			{
				ID: "mark8ly:1", TenantID: "t1", Aggregate: "order", AggregateID: "o1",
				EventType: "order.created", Status: "published", CreatedAt: "2026-08-22T10:00:00Z",
				PublishedAt: &published, Source: "mark8ly",
			},
			{
				ID: "kora:2", TenantID: "t2", Aggregate: "food", AggregateID: "f1",
				EventType: "food.updated", Status: "failed", CreatedAt: "2026-08-22T09:00:00Z",
				AgeSeconds: &age, Error: &errMsg, Source: "kora",
			},
		},
		Failures:       []domain.Failure{},
		NotImplemented: []string{},
	}

	raw, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	events, ok := body["events"].([]any)
	if !ok || len(events) != 2 {
		t.Fatalf("events = %v, want 2 events", body["events"])
	}

	published0 := events[0].(map[string]any)
	if _, hasAge := published0["age_seconds"]; hasAge {
		t.Errorf("published row carries age_seconds — must be absent, not zero")
	}
	if _, hasErr := published0["error"]; hasErr {
		t.Errorf("published row carries error — must be absent")
	}
	if _, hasPayload := published0["payload"]; hasPayload {
		t.Fatalf("event carries a payload key — the contract excludes it by construction")
	}

	failed1 := events[1].(map[string]any)
	if _, hasPublished := failed1["published_at"]; hasPublished {
		t.Errorf("failed row carries published_at — must be absent, it never went out")
	}
	if failed1["age_seconds"] != float64(120) {
		t.Errorf("age_seconds = %v, want 120", failed1["age_seconds"])
	}
	if failed1["error"] != "delivery_failed" {
		t.Errorf("error = %v, want the opaque string", failed1["error"])
	}

	if failures, ok := body["failures"].([]any); !ok || len(failures) != 0 {
		t.Fatalf("failures = %v, want an empty array, never null", body["failures"])
	}
	if ni, ok := body["not_implemented"].([]any); !ok || len(ni) != 0 {
		t.Fatalf("not_implemented = %v, want an empty array, never null", body["not_implemented"])
	}
}
