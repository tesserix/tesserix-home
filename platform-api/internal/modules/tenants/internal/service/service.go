// Package service composes the estate tenant directory from every product that
// has tenants.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strconv"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is the contract's §3.4 entity endpoint for the tenant type.
//
// `{type}` is product-defined, so this is not universal the way
// /admin/audit-logs is: a product serves `tenants` only if it has them. Which
// products those are is the caller's declaration (Config.Slugs), not something
// discovered — the same absence-means-no rule the federation registry uses.
const productPath = "/admin/entities/tenants"

// idSeparator namespaces a row's id with the product that produced it, for the
// reason the audit module states: two products returning primary key "1" are
// indistinguishable in a merged list, and the console dedupes on id.
const idSeparator = ":"

// DefaultLimit bounds what each product is asked for when the caller names no
// limit. Unbounded, the answer is truncated by the federation client's 1 MiB
// read limit, which cuts mid-JSON and surfaces as the generic "invalid
// response" rather than as "too much data".
const DefaultLimit = 100

// ErrNotInstrumented is the answer when this deployment federates NO products
// with tenants. Zero tenants is a real answer meaning "none exist", and an
// unconfigured registry must not be able to impersonate it.
var ErrNotInstrumented = errors.New("tenants: no products are configured")

// ErrUnknownSource is a filter naming a product this deployment cannot call.
// Refused rather than answered empty, so a typo does not read as "that product
// has no tenants".
var ErrUnknownSource = errors.New("tenants: unknown source")

// Query is one read of the estate tenant directory.
type Query struct {
	// Source narrows to one product; empty means every configured product.
	Source string
	// Q is a free-text search, passed THROUGH to each product rather than
	// applied here. Filtering a page this service already truncated would
	// silently search only the first N rows of each product.
	Q string
	// Status filters by the product's own status vocabulary.
	Status string
	Limit  int
}

// path renders the product endpoint carrying this query, so every product is
// asked the same bounded question.
func (q Query) path() string {
	params := url.Values{}
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	params.Set("limit", strconv.Itoa(limit))
	if q.Q != "" {
		params.Set("q", q.Q)
	}
	if q.Status != "" {
		params.Set("status", q.Status)
	}
	return productPath + "?" + params.Encode()
}

// Service reads the estate's tenants.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. slugs is every product that serves the `tenants`
// entity type. log receives one ERROR line per federation failure carrying the
// unredacted cause — the wire-facing Failure.Message is deliberately a coarse,
// closed-set string, so without this line a production outage is undiagnosable.
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Estate reads every configured product, or one named by Query.Source.
func (s *Service) Estate(ctx context.Context, op federation.Operator, q Query) (domain.Page, error) {
	if len(s.slugs) == 0 {
		return domain.Page{}, ErrNotInstrumented
	}

	slugs := s.slugs
	if q.Source != "" {
		if !contains(s.slugs, q.Source) {
			return domain.Page{}, fmt.Errorf("%w: %s", ErrUnknownSource, q.Source)
		}
		slugs = []string{q.Source}
	}

	rows, failures := federation.FanOut(ctx, s.fed, slugs, q.path(), op,
		func(slug string, body []byte) ([]domain.Tenant, error) {
			var envelope struct {
				Data []domain.Tenant `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s tenants: %w", slug, err)
			}
			// Source and id are both stamped from the slug the call was MADE
			// to, never from the body: a product cannot name itself into
			// another product's rows, and it cannot namespace its ids into
			// another product's either.
			out := make([]domain.Tenant, 0, len(envelope.Data))
			for _, row := range envelope.Data {
				row.Source = slug
				row.ID = slug + idSeparator + row.ID
				out = append(out, row)
			}
			return out, nil
		})

	// Logged over the federation.Failure values, before mapping to the domain
	// shape: federation.Failure carries the unredacted cause via Unwrap, and
	// the domain Failure deliberately does not.
	for _, f := range failures {
		s.log.Error("tenants: federated source failed",
			"source", f.Product, "error", f.Unwrap())
	}

	// Sorted by source then name so two identical reads render identically.
	// An unstable order makes a re-read look like a change.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Source != rows[j].Source {
			return rows[i].Source < rows[j].Source
		}
		return rows[i].Name < rows[j].Name
	})

	out := domain.Page{
		Tenants:  rows,
		Failures: make([]domain.Failure, 0, len(failures)),
	}
	for _, f := range failures {
		out.Failures = append(out.Failures, domain.Failure{Source: f.Product, Message: f.Error})
	}
	return out, nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
