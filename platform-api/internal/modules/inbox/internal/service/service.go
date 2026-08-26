// Package service composes the estate inbox from every product that serves one.
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
	"sync"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/inbox/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is contract §3.2, identical on every product.
const productPath = "/admin/inbox"

// idSeparator namespaces an item's id with the product that produced it — the
// same `${source}:${id}` convention the audit and tenants modules apply, and
// for the same reason: two products returning item id `1` are
// indistinguishable in a merged queue, and any consumer keying on id would
// collapse them.
const idSeparator = ":"

// ErrNotInstrumented is the answer when this deployment federates NO products.
//
// An empty queue is a REAL and good answer — it means nothing is waiting on a
// human — so an unconfigured registry must not be able to impersonate it. That
// distinction matters more here than on most surfaces: the console renders an
// empty inbox as reassurance, and reassurance produced by a missing config is
// the worst possible failure mode for a queue.
var ErrNotInstrumented = errors.New("inbox: no products are configured")

// ErrUnknownSource is a filter naming a product this deployment cannot call.
// Refused rather than answered empty, so a typo does not read as "that product
// has nothing waiting".
var ErrUnknownSource = errors.New("inbox: unknown source")

// Query is one read of the estate queue.
type Query struct {
	// Source narrows to one product; empty means every configured product.
	Source string
	// Limit bounds what each product is asked for. Defaulted by the handler
	// rather than left unset: an unbounded fan-out asks every product for its
	// entire queue, and the federation client truncates at 1 MiB mid-JSON,
	// which surfaces as a generic "invalid response" rather than as "too much".
	Limit int
}

func (q Query) path() string {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(q.Limit))
	return productPath + "?" + params.Encode()
}

// Service reads the estate's queue.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. slugs is every product declaring §3.2. log receives
// one ERROR line per federation failure carrying the unredacted cause — the
// wire-facing Failure.Message is deliberately a coarse, closed-set string, so
// without this line a production outage is undiagnosable.
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Estate returns the merged queue.
func (s *Service) Estate(ctx context.Context, op federation.Operator, q Query) (domain.Page, error) {
	if len(s.slugs) == 0 {
		// Checked before the source filter: with nothing configured every
		// source is unknown, and "you asked for a product that does not exist"
		// is a misleading way to say "this deployment federates nothing".
		return domain.Page{}, ErrNotInstrumented
	}

	slugs := s.slugs
	if q.Source != "" {
		if !contains(s.slugs, q.Source) {
			return domain.Page{}, fmt.Errorf("%w: %s", ErrUnknownSource, q.Source)
		}
		slugs = []string{q.Source}
	}

	// Totals are collected alongside the items because §3.2's `total` is the
	// product's own QUEUE DEPTH, which may exceed the bounded page it
	// returned. Summing the depths is the only honest estate backlog; counting
	// the returned items would silently under-report every product that had
	// more waiting than we asked for.
	//
	// Guarded by a mutex because federation.FanOut runs `decode` in ONE
	// GOROUTINE PER SLUG (fanout.go:132). That is not obvious from the call
	// site — the callback reads like ordinary sequential code — and an
	// unguarded map write here is a data race that `go test -race` catches
	// only when more than one product is configured, which is exactly the
	// case a single-product test would miss.
	var totalsMu sync.Mutex
	totals := make(map[string]int, len(slugs))

	items, failures := federation.FanOut(ctx, s.fed, slugs, q.path(), op,
		func(slug string, body []byte) ([]domain.Item, error) {
			// §3.2's envelope is `{items, total}` — NOT §4.1's
			// `{data, pagination}`. The inbox is the one contract endpoint
			// with its own shape, and decoding it as a page would silently
			// yield zero items for a product that answered correctly.
			var envelope struct {
				Items []domain.Item `json:"items"`
				Total int           `json:"total"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s inbox: %w", slug, err)
			}
			totalsMu.Lock()
			totals[slug] = envelope.Total
			totalsMu.Unlock()

			// Source and id are both stamped from the slug the call was MADE
			// to, never from the body: a product cannot name itself into
			// another product's items, and it cannot namespace its ids into
			// another product's either.
			for i := range envelope.Items {
				envelope.Items[i].Source = slug
				envelope.Items[i].ID = slug + idSeparator + envelope.Items[i].ID
				// Never nil on the wire. §4.5's spirit applied to a nested
				// field: the console iterates this, and `null` is a different
				// bug from `[]` in every language that reads it.
				if envelope.Items[i].Actions == nil {
					envelope.Items[i].Actions = []domain.Action{}
				}
			}
			return envelope.Items, nil
		})

	// Logged over the federation.Failure values, before mapping to the domain
	// shape: federation.Failure carries the unredacted cause via Unwrap, and
	// domain.Failure deliberately does not — it is what reaches a browser.
	for _, f := range failures {
		s.log.Error("inbox: federated source failed",
			"source", f.Product, "error", f.Error, "cause", f.Unwrap())
	}

	// OLDEST first — the opposite of the audit timeline, and deliberately so.
	// A queue exists to surface what has waited longest; newest-first would
	// bury the item most overdue under whatever arrived a moment ago. Kora
	// orders its own queue oldest-first for the same reason, and a merged
	// queue that did otherwise would undo that per product.
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].WaitingSince.Before(items[j].WaitingSince)
	})

	total := 0
	for _, n := range totals {
		total += n
	}

	out := domain.Page{
		// Never nil: the console iterates this.
		Items:    items,
		Total:    total,
		Failures: make([]domain.Failure, 0, len(failures)),
	}
	if out.Items == nil {
		out.Items = []domain.Item{}
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
