// Package service composes the estate audit timeline from every product that
// serves one.
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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is the contract's audit endpoint, identical on every product.
const productPath = "/admin/audit-logs"

// idSeparator namespaces a row's id with the product that produced it.
//
// The same `${source}:${id}` convention apps/web's attributeTo has applied
// since that app served this surface (apps/web/lib/audit/entry.ts), and the
// one apps/console/lib/audit.ts's withSource applies to the console's own
// rows. It is not cosmetic: two products returning integer primary key `12`
// are indistinguishable in a merged list keyed by id, and the console's
// dedupeIds would then start rewriting ids in what is an integrity record.
const idSeparator = ":"

// ErrNotInstrumented is the answer when this deployment federates NO products
// at all.
//
// Zero rows is a real answer meaning "nothing happened", and an unconfigured
// registry must not be able to impersonate it — the same argument the
// unknown-source refusal below makes. The handler maps this to 501, the status
// the console already reads as `instrumentation-unavailable` rather than as an
// empty timeline. Products configured but all failing is a different answer
// and keeps its 200 with a populated `failures`.
var ErrNotInstrumented = errors.New("audit: no products are configured")

// Query is one read of the estate timeline.
//
// Limit and SinceHours are REQUIRED — the handler defaults them — because the
// alternative is asking every product for its entire audit log. Unbounded,
// that answer is truncated by the federation client's 1 MiB read limit, which
// cuts mid-JSON and surfaces as the generic "invalid response".
type Query struct {
	// Source narrows to one product; empty means every product.
	Source string
	Limit  int
	// SinceHours is how far back the products are asked to reach.
	SinceHours int
}

// path renders the product endpoint carrying this query's bounds, so every
// product is asked the same bounded question.
func (q Query) path() string {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(q.Limit))
	params.Set("since_hours", strconv.Itoa(q.SinceHours))
	return productPath + "?" + params.Encode()
}

// Service reads the estate's audit rows.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. slugs is every product declaring the audit
// contract. log receives one ERROR line per federation failure, carrying the
// unredacted cause — Failure.Error on the wire is deliberately a coarse,
// closed-set string (it is rendered in a browser), so without this log line
// a production DNS/TLS/5xx outage is undiagnosable beyond "connection
// failed".
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Estate returns the merged timeline.
func (s *Service) Estate(ctx context.Context, op federation.Operator, q Query) (domain.Page, error) {
	if len(s.slugs) == 0 {
		// Checked before the source filter: with nothing configured every
		// source is unknown, and "you asked for a product that does not
		// exist" is a misleading way to say "this deployment federates
		// nothing at all".
		return domain.Page{}, ErrNotInstrumented
	}

	slugs := s.slugs
	if q.Source != "" {
		if !contains(s.slugs, q.Source) {
			// Not an empty result. Zero rows is a real answer meaning "nothing
			// happened", and a typo'd filter must not be able to impersonate it.
			return domain.Page{}, fmt.Errorf("audit: unknown source %q", q.Source)
		}
		slugs = []string{q.Source}
	}

	entries, failures := federation.FanOut(ctx, s.fed, slugs, q.path(), op,
		func(slug string, body []byte) ([]domain.Entry, error) {
			// Decodes the SAME field names this module emits: the upstream
			// product endpoint does not exist yet, and one vocabulary
			// spanning the contract means this decode is already correct
			// the day a product implements it against apps/console/lib/
			// audit.ts's shape.
			var envelope struct {
				Data []domain.Entry `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s audit rows: %w", slug, err)
			}
			// Both stamped here rather than trusted from the product: a
			// product cannot name itself into another product's rows, and it
			// cannot namespace its ids into another product's either. The
			// slug the call was MADE to wins over anything the body claims,
			// for source and for id alike.
			for i := range envelope.Data {
				envelope.Data[i].Source = slug
				envelope.Data[i].ID = slug + idSeparator + envelope.Data[i].ID
			}
			return envelope.Data, nil
		})

	// Logged over the federation.Failure values, before mapping to the
	// domain shape: federation.Failure carries the unredacted cause via
	// Unwrap(), and domain.Failure deliberately does not — it is what gets
	// marshalled to the browser, and the whole point of the sanitised
	// Message is that the raw cause never reaches a page.
	for _, f := range failures {
		s.log.Error("audit: federation source failed",
			"product", f.Product,
			"error", f.Error,
			"cause", f.Unwrap(),
		)
	}

	// Newest first. Each source returns its own rows ordered; merged, they are
	// not, and a timeline out of order is not a timeline.
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].Timestamp.After(entries[j].Timestamp)
	})

	domainFailures := make([]domain.Failure, len(failures))
	for i, f := range failures {
		domainFailures[i] = domain.Failure{Source: f.Product, Message: f.Error}
	}

	return domain.Page{Entries: entries, Failures: domainFailures}, nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
