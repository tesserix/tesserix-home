// Package service composes the estate audit timeline from every product that
// serves one.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is the contract's audit endpoint, identical on every product.
const productPath = "/admin/audit-logs"

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

// Estate returns the merged timeline. source narrows to one product; empty
// means every product.
func (s *Service) Estate(ctx context.Context, op federation.Operator, source string) (domain.Page, error) {
	slugs := s.slugs
	if source != "" {
		if !contains(s.slugs, source) {
			// Not an empty result. Zero rows is a real answer meaning "nothing
			// happened", and a typo'd filter must not be able to impersonate it.
			return domain.Page{}, fmt.Errorf("audit: unknown source %q", source)
		}
		slugs = []string{source}
	}

	entries, failures := federation.FanOut(ctx, s.fed, slugs, productPath, op,
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
			// Stamped here rather than trusted from the product: a product
			// cannot name itself into another product's rows.
			for i := range envelope.Data {
				envelope.Data[i].Source = slug
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
