// Package service reads one product's §3.4 entity records.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/entities/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is contract §3.4. `{type}` is product-defined, which is why the
// declaration below exists.
const productPath = "/admin/entities/"

// idSeparator namespaces a row's id with the product that produced it — the
// same convention the audit, tenants and inbox modules apply. It matters more
// here than anywhere: two products both serving `users` will both return small
// integer or uuid ids for entirely different people.
const idSeparator = ":"

// ErrNotInstrumented is the answer when this deployment federates nothing.
var ErrNotInstrumented = errors.New("entities: no products are configured")

// ErrUnknownSource names a product this deployment cannot call.
//
// Two situations, one sentinel, and not by choice: s.types has a key per
// FEDERATED product, and this service has no notion of the products that
// EXIST. "mark8ly, which this deployment does not federate" and "kroa, which
// is not a product at all" are both simply absent from the map. The handler
// records what that costs and why the alternative is worse.
var ErrUnknownSource = errors.New("entities: unknown source")

// ErrTypeNotServed is a product that exists but does not serve this type.
//
// Distinct from ErrUnknownSource on purpose: "kora has no tenants" and "there
// is no product called kroa" are different mistakes with different fixes, and
// collapsing them sends whoever hit it to check the wrong thing.
var ErrTypeNotServed = errors.New("entities: product does not serve this type")

// Query is one read.
type Query struct {
	// Q is the caller's search text, forwarded verbatim.
	//
	// NOT validated here, and that is deliberate: enforcing a product's rule
	// here would be a second, drifting copy of it — the same mistake the
	// console made with reason codes (tesserix-home#345). The product is the
	// authority; this forwards and surfaces the refusal.
	//
	// An EMPTY Q is a browse, and browse is the contract's shape: §3.4 now
	// records browse-and-search rather than leaving it a per-product choice
	// (tesserix/kora#473, closed by kora#480). mark8ly's
	// entities_tenants.go has always treated `q` as an optional trimmed
	// param, and Kora now matches — so an absent query lists, paged, on both.
	//
	// This module happened to be correct before that landed, because
	// forwarding verbatim is right under either answer. That is the argument
	// for forwarding rather than validating, not a lucky escape.
	Q     string
	Limit int
	// Page is 1-based, and forwarded only when above 1.
	//
	// Omitted at 1 rather than always sent, for the same reason an empty `q`
	// is omitted: `page=1` is the default on both implementers, and sending it
	// makes every first-page URL differ from the one a product would build
	// itself — which matters when comparing this service's requests against a
	// product's own logs.
	Page int
}

func (q Query) path(entityType string) string {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(q.Limit))
	if q.Q != "" {
		params.Set("q", q.Q)
	}
	if q.Page > 1 {
		params.Set("page", strconv.Itoa(q.Page))
	}
	// The type is escaped: it reaches here from a URL path segment, and an
	// unescaped one would let a caller reshape the product-facing request.
	// It has already been checked against the product's declaration, so this
	// is defence in depth rather than the only gate.
	return productPath + url.PathEscape(entityType) + "?" + params.Encode()
}

// Service reads one product's entity records.
type Service struct {
	fed *federation.Client
	// types maps a product slug to the §3.4 types it DECLARED. Absence means
	// it serves none — the same absence-means-no rule the registry uses.
	types map[string][]string
	log   *slog.Logger
}

func New(fed *federation.Client, types map[string][]string, log *slog.Logger) *Service {
	return &Service{fed: fed, types: types, log: log}
}

// Read fetches one product's records of one type.
//
// # There is no fan-out, deliberately
//
// An entity TYPE is not universal the way an audit row is. `users` in Kora and
// `users` in another product are different populations with different columns;
// merging them produces a table where a column means something different per
// row, which is exactly what §8.5's "can two products' rows sit in one table?"
// test exists to catch. So the caller names the product.
func (s *Service) Read(
	ctx context.Context, op federation.Operator, source, entityType string, q Query,
) (domain.Page, error) {
	if len(s.types) == 0 {
		return domain.Page{}, ErrNotInstrumented
	}

	declared, known := s.types[source]
	if !known {
		return domain.Page{}, fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}

	// Refused rather than forwarded. An undeclared type reaches the product as
	// a 404, which arrives back looking like an outage — the operator is told
	// the product is down when the truth is that it never had that type. The
	// declaration is the cheaper, more honest gate.
	if !contains(declared, entityType) {
		return domain.Page{}, fmt.Errorf("%w: %s does not serve %q", ErrTypeNotServed, source, entityType)
	}

	body, err := s.fed.Get(ctx, source, q.path(entityType), op)
	if err != nil {
		s.log.Error("entities: federated read failed",
			"source", source, "type", entityType, "error", err)
		return domain.Page{}, fmt.Errorf("reading %s %s: %w", source, entityType, err)
	}

	var envelope struct {
		Data       []domain.Entity   `json:"data"`
		Pagination domain.Pagination `json:"pagination"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return domain.Page{}, fmt.Errorf("decoding %s %s: %w", source, entityType, err)
	}

	// Source, type and id are stamped from what was ASKED, never from what the
	// body claims: a product cannot name itself into another product's rows,
	// cannot relabel the type it was asked for, and cannot namespace its ids
	// into another product's.
	for i := range envelope.Data {
		envelope.Data[i].Source = source
		envelope.Data[i].Type = entityType
		envelope.Data[i].ID = source + idSeparator + envelope.Data[i].ID
	}

	return domain.Page{
		// Never nil: the console iterates this.
		Data:       nonNil(envelope.Data),
		Pagination: envelope.Pagination,
	}, nil
}

func nonNil(rows []domain.Entity) []domain.Entity {
	if rows == nil {
		return []domain.Entity{}
	}
	return rows
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
