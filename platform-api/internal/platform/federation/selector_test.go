package federation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestGetForEndpointIsByteIdenticalToGetOnASingleServiceProduct pins
// compatibility case #1: a single-service product (kora, and mark8ly before
// #720) must behave exactly the same whether the call site uses the plain
// Get or the new GetForEndpoint/GetForEntity variants — the endpoint or
// entity is simply irrelevant when there is only one service to resolve to.
func TestGetForEndpointIsByteIdenticalToGetOnASingleServiceProduct(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Path
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "kora", Services: []Service{{
			Name: "kora", BaseURL: srv.URL, Secret: "s",
			Endpoints: []string{"outbox"}, Entities: []string{"tenants"},
		}}},
	}), srv.Client())

	if _, err := c.GetForEndpoint(context.Background(), "kora", "outbox", "/admin/outbox", operator()); err != nil {
		t.Fatalf("GetForEndpoint: %v", err)
	}
	if got != "/admin/outbox" {
		t.Fatalf("got path %q, want /admin/outbox", got)
	}

	if _, err := c.GetForEntity(context.Background(), "kora", "tenants", "/admin/entities/tenants", operator()); err != nil {
		t.Fatalf("GetForEntity: %v", err)
	}
	if got != "/admin/entities/tenants" {
		t.Fatalf("got path %q, want /admin/entities/tenants", got)
	}
}

// TestGetForEndpointResolvesToTheDeclaringServiceOfAMultiServiceProduct is
// requirement #2: a multi-service product routes to whichever service
// declared the endpoint the call is for.
func TestGetForEndpointResolvesToTheDeclaringServiceOfAMultiServiceProduct(t *testing.T) {
	var gotHost string
	marketplace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = "marketplace-api"
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer marketplace.Close()
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = "platform-api"
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer platform.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: marketplace.URL, Secret: "s1", Endpoints: []string{"outbox", "billing"}},
			{Name: "platform-api", BaseURL: platform.URL, Secret: "s2", Endpoints: []string{"email-templates"}},
		}},
	}), marketplace.Client())

	if _, err := c.GetForEndpoint(context.Background(), "mark8ly", "outbox", "/admin/outbox", operator()); err != nil {
		t.Fatalf("GetForEndpoint(outbox): %v", err)
	}
	if gotHost != "marketplace-api" {
		t.Fatalf("outbox went to %q, want marketplace-api", gotHost)
	}
}

// TestGetForEndpointFailsClosedOnZeroMatches is requirement #3's first half:
// a product that IS configured but declares the endpoint on none of its
// services must be refused, naming the product, the path and what was
// looked for — not silently answered as if the product had nothing.
func TestGetForEndpointFailsClosedOnZeroMatches(t *testing.T) {
	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: "http://unused", Secret: "s1", Endpoints: []string{"outbox"}},
		}},
	}), http.DefaultClient)

	_, err := c.GetForEndpoint(context.Background(), "mark8ly", "no-such-endpoint", "/admin/x", operator())
	if !errors.Is(err, ErrNoMatchingService) {
		t.Fatalf("err = %v, want ErrNoMatchingService", err)
	}
	for _, want := range []string{"mark8ly", "/admin/x", "no-such-endpoint"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, want it to mention %q", err.Error(), want)
		}
	}
}

// TestGetForEndpointFailsClosedOnMultipleMatches is requirement #3's second
// half: mark8ly's split email-template registry is a LEGITIMATE
// configuration, but Get is a single-response method and must refuse rather
// than guess — and the refusal must point the caller at the fan-out API
// instead of just saying "ambiguous".
func TestGetForEndpointFailsClosedOnMultipleMatches(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: srv.URL, Secret: "s1", Endpoints: []string{"email-templates"}},
			{Name: "platform-api", BaseURL: srv.URL, Secret: "s2", Endpoints: []string{"email-templates"}},
		}},
	}), srv.Client())

	_, err := c.GetForEndpoint(context.Background(), "mark8ly", "email-templates", "/admin/email-templates", operator())
	if !errors.Is(err, ErrAmbiguousService) {
		t.Fatalf("err = %v, want ErrAmbiguousService", err)
	}
	if called {
		t.Error("an ambiguous call must not silently pick a service and send the request")
	}
	if !strings.Contains(err.Error(), "mark8ly") || !strings.Contains(err.Error(), "2") {
		t.Errorf("err = %q, want it to name the product and the number of matching services", err.Error())
	}
}

// TestGetForEntityResolvesAndFailsClosedTheSameWay is the entity-axis
// counterpart of the endpoint tests above — Product.resolve's other branch.
func TestGetForEntityResolvesAndFailsClosedTheSameWay(t *testing.T) {
	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: "http://unused-1", Secret: "s1", Entities: []string{"tenants"}},
			{Name: "platform-api", BaseURL: "http://unused-2", Secret: "s2", Entities: []string{"users"}},
		}},
	}), http.DefaultClient)

	// Zero matches.
	_, err := c.GetForEntity(context.Background(), "mark8ly", "no-such-entity", "/x", operator())
	if !errors.Is(err, ErrNoMatchingService) {
		t.Fatalf("err = %v, want ErrNoMatchingService", err)
	}

	// One match resolves — proven by NOT getting ErrNoMatchingService or
	// ErrAmbiguousService; the request itself fails only because the fake
	// BaseURL is unreachable, which is a transport error, not a resolution one.
	_, err = c.GetForEntity(context.Background(), "mark8ly", "tenants", "/x", operator())
	if errors.Is(err, ErrNoMatchingService) || errors.Is(err, ErrAmbiguousService) {
		t.Fatalf("err = %v, want resolution to succeed (transport may still fail)", err)
	}
}

// TestPlainGetStillFailsClosedOnAMultiServiceProductWithNoSelector pins that
// a call site NOT yet updated to name an endpoint or entity keeps getting
// today's fail-closed behaviour rather than an ambiguous guess — Get's
// contract is unchanged for a caller that gives it no context.
func TestPlainGetStillFailsClosedOnAMultiServiceProductWithNoSelector(t *testing.T) {
	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: "http://unused-1", Secret: "s1"},
			{Name: "platform-api", BaseURL: "http://unused-2", Secret: "s2"},
		}},
	}), http.DefaultClient)

	_, err := c.Get(context.Background(), "mark8ly", "/admin/audit-logs", operator())
	if !errors.Is(err, ErrAmbiguousService) {
		t.Fatalf("err = %v, want ErrAmbiguousService — a plain Get on a 2-service product has no context to resolve with", err)
	}
}

// TestPostForEndpointAndPutForEndpointAlsoFailClosedOnAmbiguity extends the
// same guarantee to the write path, since mark8ly's split email-template
// registry is written to (PUT, upsert) and posted to (test-send) as well as
// read.
func TestPostForEndpointAndPutForEndpointAlsoFailClosedOnAmbiguity(t *testing.T) {
	reg := NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: "http://unused-1", Secret: "s1", Endpoints: []string{"email-templates"}},
			{Name: "platform-api", BaseURL: "http://unused-2", Secret: "s2", Endpoints: []string{"email-templates"}},
		}},
	})
	c := NewClient(reg, http.DefaultClient)

	if _, err := c.PostForEndpoint(context.Background(), "mark8ly", "email-templates", "/x", []byte(`{}`), operator(), postOpts()); !errors.Is(err, ErrAmbiguousService) {
		t.Fatalf("PostForEndpoint err = %v, want ErrAmbiguousService", err)
	}
	if _, err := c.PutForEndpoint(context.Background(), "mark8ly", "email-templates", "/x", []byte(`{}`), operator(), postOpts()); !errors.Is(err, ErrAmbiguousService) {
		t.Fatalf("PutForEndpoint err = %v, want ErrAmbiguousService", err)
	}
}

// TestFanOutResolvesPerSlugWithTheGivenSelector proves FanOut's new sel
// parameter actually reaches the per-product resolution: a slug whose
// matching service moved (still exactly one match) keeps merging normally,
// so the fix does not regress the common single-match-per-endpoint case
// every module in production uses today.
func TestFanOutResolvesPerSlugWithTheGivenSelector(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"a"}]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: srv.URL, Secret: "s", Endpoints: []string{"outbox"}},
		}},
	}), srv.Client())

	rows, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/admin/outbox", operator(), ForEndpoint("outbox"), decodeRows)
	if len(failures) != 0 {
		t.Fatalf("failures = %v, want none", failures)
	}
	if len(rows) != 1 || rows[0].ID != "a" {
		t.Fatalf("rows = %v, want one row", rows)
	}
}

// TestFanOutReportsAmbiguityAsAFailureNotAPanicOrSilentPick proves that when
// a slug's selector resolves to more than one service, FanOut's per-slug call
// degrades to a Failure (sanitised, not the raw ambiguity error) instead of
// silently reading one of the two services — the same fail-closed guarantee
// Get gives, applied to the fan-out path.
func TestFanOutReportsAmbiguityAsAFailureNotAPanicOrSilentPick(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"a"}]}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: srv.URL, Secret: "s1", Endpoints: []string{"email-templates"}},
			{Name: "platform-api", BaseURL: srv.URL, Secret: "s2", Endpoints: []string{"email-templates"}},
		}},
	}), srv.Client())

	rows, failures := FanOut(context.Background(), c, []string{"mark8ly"}, "/admin/email-templates", operator(), ForEndpoint("email-templates"), decodeRows)
	if len(rows) != 0 {
		t.Fatalf("rows = %v, want none — an ambiguous product contributes nothing silently", rows)
	}
	if len(failures) != 1 || failures[0].Product != "mark8ly" {
		t.Fatalf("failures = %v, want one naming mark8ly", failures)
	}
	if !errors.Is(failures[0].Unwrap(), ErrAmbiguousService) {
		t.Fatalf("failures[0].Unwrap() = %v, want ErrAmbiguousService", failures[0].Unwrap())
	}
}

// TestFanOutServicesCallsEveryMatchAndMergesNothingItself proves the new
// fan-out primitive: it calls every matching service concurrently and hands
// back one raw result per service, without collapsing a partial failure into
// the whole call failing.
func TestFanOutServicesCallsEveryMatchAndMergesNothingItself(t *testing.T) {
	marketplace := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"order_paid"}]}`))
	}))
	defer marketplace.Close()
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer platform.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: marketplace.URL, Secret: "s1", Endpoints: []string{"email-templates"}},
			{Name: "platform-api", BaseURL: platform.URL, Secret: "s2", Endpoints: []string{"email-templates"}},
		}},
	}), marketplace.Client())

	results, err := FanOutServices(context.Background(), c, "mark8ly", ForEndpoint("email-templates"), "/admin/email-templates", operator())
	if err != nil {
		t.Fatalf("FanOutServices: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %+v, want 2 — one per matching service", results)
	}

	byName := map[string]ServiceResult{}
	for _, r := range results {
		byName[r.Service] = r
	}
	mp, ok := byName["marketplace-api"]
	if !ok || mp.Err != nil || !strings.Contains(string(mp.Body), "order_paid") {
		t.Fatalf("marketplace-api result = %+v, want a successful body containing order_paid", mp)
	}
	pf, ok := byName["platform-api"]
	if !ok || pf.Err == nil {
		t.Fatalf("platform-api result = %+v, want a transport/status error, not nil", pf)
	}
}

// TestFanOutServicesFailsClosedOnZeroMatches mirrors Get's zero-match
// behaviour: a configured product that declares the endpoint on none of its
// services has nothing to fan out to at all, and that is a real error, not
// an empty result set.
func TestFanOutServicesFailsClosedOnZeroMatches(t *testing.T) {
	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "marketplace-api", BaseURL: "http://unused", Secret: "s1", Endpoints: []string{"outbox"}},
		}},
	}), http.DefaultClient)

	_, err := FanOutServices(context.Background(), c, "mark8ly", ForEndpoint("email-templates"), "/x", operator())
	if !errors.Is(err, ErrNoMatchingService) {
		t.Fatalf("err = %v, want ErrNoMatchingService", err)
	}
}

// TestFanOutServicesRunsConcurrently is a light guard against a regression to
// sequential calls, mirroring the same spirit as the existing FanOut
// concurrency tests elsewhere in this package: N slow services must not take
// N times as long.
func TestFanOutServicesRunsConcurrently(t *testing.T) {
	arrived := make(chan struct{}, 2)
	block := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		arrived <- struct{}{}
		<-block
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := NewClient(NewRegistry([]Product{
		{Slug: "mark8ly", Services: []Service{
			{Name: "a", BaseURL: srv.URL, Secret: "s1", Endpoints: []string{"x"}},
			{Name: "b", BaseURL: srv.URL, Secret: "s2", Endpoints: []string{"x"}},
		}},
	}), srv.Client())

	done := make(chan struct{})
	go func() {
		_, _ = FanOutServices(context.Background(), c, "mark8ly", ForEndpoint("x"), "/x", operator())
		close(done)
	}()

	// Both services must have reached the (blocked) handler before either
	// can finish — proof they were called concurrently rather than one
	// waiting for the other. A sequential implementation would deadlock this
	// test on the second <-arrived, which the timeout below catches.
	timeout := time.After(5 * time.Second)
	for range 2 {
		select {
		case <-arrived:
		case <-timeout:
			t.Fatal("timed out waiting for both services to be called concurrently")
		}
	}
	close(block)
	<-done
}
