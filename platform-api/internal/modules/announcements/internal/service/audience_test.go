package service

import (
	"context"
	"errors"
	"testing"
)

// The audience preview, which #150 wants so an operator "should see who it
// will reach before sending, not after".
//
// Every test here is about the same thing: a NUMBER IS A CLAIM. This platform
// cannot count every product's tenants, and the failure that matters is not an
// error — it is a plausible-looking figure that is wrong, shown next to a
// button that sends something irrevocable.

type stubTenants struct {
	rows   map[string][]string // product -> tenant statuses
	failed []string
	limit  int
}

func (s stubTenants) Tenants(_ context.Context, _ Operator, slugs []string) (map[string][]string, []string, error) {
	out := map[string][]string{}
	for _, slug := range slugs {
		if rows, ok := s.rows[slug]; ok {
			out[slug] = rows
		}
	}
	return out, s.failed, nil
}

func (s stubTenants) Serving() []string {
	out := make([]string, 0, len(s.rows))
	for k := range s.rows {
		out = append(out, k)
	}
	return out
}

// Products is every federated product. `kora` is deliberately here and NOT in
// Serving: it federates users and foods, so it is a real target whose audience
// cannot be counted — which is a different thing from a typo.
func (s stubTenants) Products() []string {
	out := []string{"kora"}
	for k := range s.rows {
		out = append(out, k)
	}
	return out
}

func (s stubTenants) Limit() int {
	if s.limit == 0 {
		return 100
	}
	return s.limit
}

func svcWith(t stubTenants) *Service { return &Service{tenants: t} }

func find(a AudiencePayload, product string) AudienceEntry {
	for _, e := range a.Audience {
		if e.Product == product {
			return e
		}
	}
	return AudienceEntry{Product: "(absent)"}
}

func TestAProductThatFederatesTenantsIsCounted(t *testing.T) {
	s := svcWith(stubTenants{rows: map[string][]string{
		"mark8ly": {"active", "active", "trialing", "suspended"},
	}})

	got, err := s.Audience(context.Background(), Operator{}, []string{"mark8ly"}, []string{"active"})
	if err != nil {
		t.Fatalf("Audience: %v", err)
	}
	e := find(got, "mark8ly")
	if !e.Countable || e.Count != 2 {
		t.Errorf("mark8ly = %+v, want a countable 2", e)
	}
}

// The finding that shaped this: kora federates `users` and `foods`, not
// `tenants`. Its audience is UNKNOWABLE from here, and a zero would read as
// "reaches nobody" — the opposite of the truth, next to a send button.
func TestAProductThatDoesNotFederateTenantsIsUncountableAndNotZero(t *testing.T) {
	s := svcWith(stubTenants{rows: map[string][]string{"mark8ly": {"active"}}})

	got, err := s.Audience(context.Background(), Operator{}, []string{"mark8ly", "kora"}, []string{"active"})
	if err != nil {
		t.Fatalf("Audience: %v", err)
	}
	e := find(got, "kora")
	if e.Countable {
		t.Fatal("kora was reported as countable")
	}
	if e.Count != 0 || e.Reason != ReasonNotFederated {
		t.Errorf("kora = %+v, want an uncountable not_federated", e)
	}
}

// A product that is DOWN is also uncountable — but for a different reason, and
// the difference is what an operator does next: one is permanent, the other is
// "try again in a minute".
func TestAProductThatFailsIsUncountableForADifferentReason(t *testing.T) {
	s := svcWith(stubTenants{
		rows:   map[string][]string{"mark8ly": {"active"}},
		failed: []string{"mark8ly"},
	})

	got, err := s.Audience(context.Background(), Operator{}, []string{"mark8ly"}, []string{"active"})
	if err != nil {
		t.Fatalf("Audience: %v", err)
	}
	e := find(got, "mark8ly")
	if e.Countable {
		t.Fatal("a failed source was counted — its rows are a partial answer, not a total")
	}
	if e.Reason != ReasonUnavailable {
		t.Errorf("reason = %q, want unavailable", e.Reason)
	}
}

// The trap the federated contract sets: the response carries NO total and the
// request carries a limit. A page that came back full may have been truncated,
// so counting it yields a number that is wrong and looks right.
func TestAPossiblyTruncatedPageIsNotReportedAsATotal(t *testing.T) {
	s := svcWith(stubTenants{
		rows:  map[string][]string{"mark8ly": {"active", "active", "active"}},
		limit: 3, // exactly the limit — there may be a fourth
	})

	got, err := s.Audience(context.Background(), Operator{}, []string{"mark8ly"}, []string{"active"})
	if err != nil {
		t.Fatalf("Audience: %v", err)
	}
	e := find(got, "mark8ly")
	if e.Countable {
		t.Fatal("a full page was reported as an exact count")
	}
	if e.Reason != ReasonExceedsLimit {
		t.Errorf("reason = %q, want exceeds_limit", e.Reason)
	}
	if e.CountedAtLeast != 3 {
		t.Errorf("CountedAtLeast = %d, want the 3 actually seen", e.CountedAtLeast)
	}
}

func TestNoStatusFilterCountsEveryTenant(t *testing.T) {
	// An untargeted announcement reaches every status, matching the read
	// query's "statuses IS NULL means all" branch.
	s := svcWith(stubTenants{rows: map[string][]string{
		"mark8ly": {"active", "trialing", "suspended"},
	}})

	got, _ := s.Audience(context.Background(), Operator{}, []string{"mark8ly"}, nil)
	if e := find(got, "mark8ly"); e.Count != 3 {
		t.Errorf("count = %d, want all 3", e.Count)
	}
}

func TestNoProductFilterAsksEveryProductThatServesTenants(t *testing.T) {
	// An untargeted announcement reaches every product, so the preview must
	// cover every product rather than none.
	s := svcWith(stubTenants{rows: map[string][]string{
		"mark8ly": {"active"}, "homechef": {"active", "active"},
	}})

	got, _ := s.Audience(context.Background(), Operator{}, nil, []string{"active"})
	if len(got.Audience) != 2 {
		t.Fatalf("got %d products, want both", len(got.Audience))
	}
}

func TestTheTotalIsOnlyTheCountableProducts(t *testing.T) {
	// And it must SAY so, otherwise "37" reads as the whole audience when
	// another product's share is simply unknown.
	s := svcWith(stubTenants{rows: map[string][]string{"mark8ly": {"active", "active"}}})

	got, _ := s.Audience(context.Background(), Operator{}, []string{"mark8ly", "kora"}, []string{"active"})
	if got.CountableTotal != 2 {
		t.Errorf("CountableTotal = %d, want 2", got.CountableTotal)
	}
	if !got.HasUncountable {
		t.Error("HasUncountable was false while kora was uncountable — the confirm step would name 2 as the whole audience")
	}
}

func TestAnUnknownProductIsRefusedRatherThanSilentlyEmpty(t *testing.T) {
	// A typo'd product name would otherwise preview as "reaches nobody" and
	// send to nobody, with no error at any point.
	s := svcWith(stubTenants{rows: map[string][]string{"mark8ly": {"active"}}})

	_, err := s.Audience(context.Background(), Operator{}, []string{"mrak8ly"}, nil)
	if err == nil {
		t.Fatal("an unknown product was accepted")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}
