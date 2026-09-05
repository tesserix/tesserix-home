package service

import (
	"context"
	"fmt"
	"slices"
)

// Operator is who a federated call is made on behalf of.
//
// Mirrors federation.Operator rather than importing it, so this package stays
// testable without a live federation client and the module keeps its "kernel
// only" import rule honest.
type Operator struct {
	ID         string
	Capability string
}

// TenantSource is how the audience is counted.
//
// An interface rather than a federation.Client because the counting RULES are
// what matter here and they must be testable without a network — every honest
// answer this file can give depends on distinguishing "no tenants" from "could
// not ask", and that distinction is impossible to exercise against a live
// fan-out.
type TenantSource interface {
	// Tenants returns each product's tenant statuses, plus the slugs whose
	// call FAILED. A product may appear in both: a partial page is not a
	// total, and the failure list is what says so.
	Tenants(ctx context.Context, op Operator, slugs []string) (map[string][]string, []string, error)
	// Serving is every product that federates the `tenants` entity — the ones
	// whose audience can be counted.
	Serving() []string
	// Products is every federated product, whether or not it serves tenants.
	//
	// Both lists are needed to tell three cases apart that otherwise collapse
	// into one: a product that can be counted, a product that legitimately
	// cannot (kora, which federates users and foods), and a TYPO. Without
	// this, a misspelled slug previews as "reaches nobody" and sends to
	// nobody, with no error at any point.
	Products() []string
	// Limit is the page size requested per product. A returned page of exactly
	// this size may have been truncated.
	Limit() int
}

// Why an audience could not be counted.
const (
	// ReasonNotFederated — the product does not serve the `tenants` entity, so
	// its audience is not knowable from here at all. Permanent: kora federates
	// `users` and `foods`, and no retry changes that.
	ReasonNotFederated = "not_federated"
	// ReasonUnavailable — the product was asked and did not answer. Transient.
	ReasonUnavailable = "unavailable"
	// ReasonExceedsLimit — a full page came back, and the federated contract
	// carries no total, so there may be more. The rows seen are reported as a
	// floor rather than a count.
	ReasonExceedsLimit = "exceeds_limit"
)

// AudienceEntry is one product's share of an announcement's audience.
type AudienceEntry struct {
	Product string `json:"product"`
	// Countable says whether Count is a number or a silence. It exists so a
	// client cannot read a zero as "reaches nobody" when it means "cannot ask".
	Countable bool `json:"countable"`
	// Count is meaningful ONLY when Countable. It is left at zero otherwise
	// rather than omitted, because a missing field and a zero read the same in
	// most clients and the bool is the thing that disambiguates.
	Count int `json:"count"`
	// Reason is set only when Countable is false.
	Reason string `json:"reason,omitempty"`
	// CountedAtLeast is the floor for ReasonExceedsLimit: what was actually
	// seen, which is real information even though it is not the total.
	CountedAtLeast int `json:"counted_at_least,omitempty"`
}

// AudiencePayload is the preview.
type AudiencePayload struct {
	Audience []AudienceEntry `json:"audience"`
	// CountableTotal sums only the products that could be counted.
	CountableTotal int `json:"countable_total"`
	// HasUncountable is what stops CountableTotal being read as "the
	// audience". #150 asks that sending "name the audience size"; where part
	// of it cannot be measured, the honest thing is to name what was measured
	// AND say that it is not all of it.
	HasUncountable bool `json:"has_uncountable"`
}

// Audience previews who an announcement would reach.
//
// `products` and `statuses` are the audience_filter's two keys. An EMPTY list
// means "every one", matching the read query's NULL branches — an untargeted
// broadcast reaches everything, and the preview must say so rather than
// nothing.
func (s *Service) Audience(ctx context.Context, op Operator, products, statuses []string) (AudiencePayload, error) {
	serving := s.tenants.Serving()

	asked := products
	if len(asked) == 0 {
		// Untargeted: every product is in the audience. Products that do not
		// federate tenants are still IN it — they are simply uncountable, and
		// they appear below saying so rather than being dropped.
		asked = serving
	}

	countable := make([]string, 0, len(asked))
	for _, p := range asked {
		if slices.Contains(serving, p) {
			countable = append(countable, p)
		}
	}

	// A product this platform has never heard of is a typo. Refused rather
	// than previewed as empty: "reaches nobody" and "you misspelled mark8ly"
	// look identical on screen, and only one is worth stopping for.
	//
	// Checked against every federated product, not against the tenant-serving
	// ones — kora is a legitimate target whose audience cannot be counted, and
	// refusing it would make the preview stricter than the send it previews.
	known := s.tenants.Products()
	for _, p := range products {
		if !slices.Contains(known, p) {
			return AudiencePayload{}, fmt.Errorf(
				"%w: %q is not a product this platform federates", ErrRefused, p)
		}
	}

	rows, failed, err := s.tenants.Tenants(ctx, op, countable)
	if err != nil {
		return AudiencePayload{}, err
	}

	limit := s.tenants.Limit()
	out := AudiencePayload{Audience: make([]AudienceEntry, 0, len(asked))}

	for _, product := range asked {
		entry := AudienceEntry{Product: product}
		switch {
		case !slices.Contains(serving, product):
			entry.Reason = ReasonNotFederated
		case slices.Contains(failed, product):
			// Rows may have arrived before the failure. They are a fragment,
			// and a fragment presented as a total is the wrong answer stated
			// confidently.
			entry.Reason = ReasonUnavailable
		default:
			seen := rows[product]
			matched := countMatching(seen, statuses)
			if len(seen) >= limit {
				entry.Reason = ReasonExceedsLimit
				entry.CountedAtLeast = matched
			} else {
				entry.Countable = true
				entry.Count = matched
				out.CountableTotal += matched
			}
		}
		if !entry.Countable {
			out.HasUncountable = true
		}
		out.Audience = append(out.Audience, entry)
	}

	return out, nil
}

// countMatching counts tenants whose status is in `statuses`.
//
// An EMPTY status list matches everything, mirroring the read query's
// `audience_filter->'statuses' IS NULL` branch. Getting this backwards would
// preview zero for the commonest announcement there is: an untargeted one.
func countMatching(have, want []string) int {
	if len(want) == 0 {
		return len(have)
	}
	n := 0
	for _, status := range have {
		if slices.Contains(want, status) {
			n++
		}
	}
	return n
}
