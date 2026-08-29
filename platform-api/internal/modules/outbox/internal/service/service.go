// Package service composes the estate outbox from every product that
// implements the contract's outbox endpoint.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is the contract's outbox endpoint, identical on every product
// that implements it — mark8ly's is pinned at
// services/marketplace-api/internal/handlers/platformadmin/outbox.go:60.
const productPath = "/admin/outbox"

// idSeparator namespaces a row's id with the product that produced it, the
// same `${source}:${id}` convention the audit and inbox modules apply. An
// outbox_events id is a UUID today, so a literal collision between two
// products is not the realistic risk it is for audit's integer keys — the
// namespacing is applied anyway, for the same reason the source stamp below
// is: a product's response is not trusted to name itself, and one merged-id
// convention across every federated list means a future caller does not have
// to remember which surfaces do this and which do not.
const idSeparator = ":"

// ErrNotInstrumented is the answer when this deployment federates NO
// products for the outbox endpoint at all.
//
// Zero rows is a real answer meaning "nothing is stuck", and an unconfigured
// registry must not be able to impersonate it. This is not a hypothetical
// today: SlugsImplementing("outbox") returns an empty list in production
// right now — mark8ly has no FEDERATION_MARK8LY_ENDPOINTS entry yet — and the
// handler maps this to 501, the status the console already reads as
// `instrumentation-unavailable` rather than as an empty, reassuring outbox.
var ErrNotInstrumented = errors.New("outbox: no products are configured")

// Query is one read of the estate outbox. Every field is optional and, when
// unset, is left off the request entirely so each product applies its own
// default — mirroring mark8ly's own parseFilter, which treats an absent
// parameter as "no opinion" rather than a locally-invented default.
type Query struct {
	Status           string
	EventType        string
	OlderThanMinutes *int
	SinceHours       *int
	TenantID         string
	Page             *int
	Limit            *int
}

// path renders the product endpoint carrying this query's filters, so every
// product is asked the same question.
func (q Query) path() string {
	params := url.Values{}
	if q.Status != "" {
		params.Set("status", q.Status)
	}
	if q.EventType != "" {
		params.Set("event_type", q.EventType)
	}
	if q.OlderThanMinutes != nil {
		params.Set("older_than_minutes", strconv.Itoa(*q.OlderThanMinutes))
	}
	if q.SinceHours != nil {
		params.Set("since_hours", strconv.Itoa(*q.SinceHours))
	}
	if q.TenantID != "" {
		params.Set("tenant_id", q.TenantID)
	}
	if q.Page != nil {
		params.Set("page", strconv.Itoa(*q.Page))
	}
	if q.Limit != nil {
		params.Set("limit", strconv.Itoa(*q.Limit))
	}
	if len(params) == 0 {
		return productPath
	}
	return productPath + "?" + params.Encode()
}

// Service reads the estate's outbox rows.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. slugs is every product declaring the outbox
// contract endpoint. log receives one ERROR line per federation failure,
// carrying the unredacted cause — Failure.Error on the wire is deliberately a
// coarse, closed-set string (it is rendered in a browser), so without this
// log line a production DNS/TLS/5xx outage is undiagnosable beyond
// "connection failed".
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Estate returns the merged outbox.
func (s *Service) Estate(ctx context.Context, op federation.Operator, q Query) (domain.Page, error) {
	if len(s.slugs) == 0 {
		return domain.Page{}, ErrNotInstrumented
	}

	events, failures := federation.FanOut(ctx, s.fed, s.slugs, q.path(), op,
		func(slug string, body []byte) ([]domain.Event, error) {
			// §4.1's envelope: `{data, pagination}`. Only `data` is read —
			// each product paginates its own rows, and merging pagination
			// counters across products would produce a "total" that is not
			// the count of anything real, the same reason the audit module
			// discards this envelope's pagination too.
			var envelope struct {
				Data []domain.Event `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s outbox rows: %w", slug, err)
			}
			// Both stamped here rather than trusted from the body: a product
			// cannot name itself into another product's rows, and it cannot
			// namespace its ids into another product's either. The slug the
			// call was MADE to wins over anything the body claims.
			for i := range envelope.Data {
				envelope.Data[i].Source = slug
				envelope.Data[i].ID = slug + idSeparator + envelope.Data[i].ID
			}
			return envelope.Data, nil
		})

	// Split the fan-out's failures into two lists BEFORE anything is logged
	// or returned. A product answering 501 is making a contract statement —
	// "I have nothing to report" — not failing to answer, and the kpis
	// module draws exactly this line for the same reason: collapsing the two
	// tells an operator a source is broken when it has simply said it has
	// none, which is the more dangerous of the two mistakes on a page used
	// to judge estate health.
	//
	// Deliberately narrower than kpis, which folds 404 into the same
	// "not instrumented" bucket alongside 501 (kpis/internal/service/
	// service.go:89-91) — there, kpis.Slugs() fans out to EVERY product, so a
	// product that never mounted /admin/kpis at all is a normal, expected
	// configuration and 404 is the honest way it says so. This module is
	// different: s.slugs here comes from SlugsImplementing("outbox"), which
	// means every slug reaching this loop already DECLARED it serves this
	// endpoint. A 404 from one of them is not a product saying "I have
	// none" — it is the registry's declaration being stale (the route was
	// removed, or was never mounted despite the declaration), and silently
	// reclassifying that as "not implemented" would hide a real
	// misconfiguration behind a legitimate-looking answer. Only 501 — the
	// product ITSELF, at the endpoint it declared, saying it has nothing
	// this time — earns that treatment. A 404 here stays a Failure, loud on
	// purpose.
	realFailures := make([]federation.Failure, 0, len(failures))
	notImplemented := make([]string, 0, len(failures))
	for _, f := range failures {
		if status, ok := federation.StatusOf(f.Unwrap()); ok && status == http.StatusNotImplemented {
			notImplemented = append(notImplemented, f.Product)
			continue
		}
		realFailures = append(realFailures, f)
	}
	sort.Strings(notImplemented)

	// Logged over the federation.Failure values, before mapping to the
	// domain shape: federation.Failure carries the unredacted cause via
	// Unwrap(), and domain.Failure deliberately does not — it is what gets
	// marshalled to the browser, and the whole point of the sanitised
	// Message is that the raw cause never reaches a page. A 501 is not
	// logged here at all — it is the expected shape of "this product has no
	// outbox to report right now", not a fault worth an ERROR line.
	for _, f := range realFailures {
		s.log.Error("outbox: federation source failed",
			"product", f.Product,
			"error", f.Error,
			"cause", f.Unwrap(),
		)
	}

	// Newest first, matching the audit timeline: a governance surface exists
	// to show what happened most recently, and a merged list is not ordered
	// on its own even though each source returns its own rows in order.
	//
	// Parsed as a real instant rather than compared as a string. A naive
	// string compare only agrees with chronological order when every
	// product emits the exact same textual form — UTC, `Z`, no fractional
	// seconds, which is what mark8ly's toOutboxRow happens to produce today
	// (time.RFC3339 via .UTC().Format) — and silently disagrees the moment
	// any product sends an offset (`+05:30`) or a fractional second: RFC
	// 3339 permits both, and TestEstateSortsByInstantNotByStringOrder pins
	// an example where the lexical order and the chronological order are
	// opposite. A row whose CreatedAt fails to parse sorts last: it cannot
	// be placed correctly, and last is less misleading than treating an
	// unparsable string as "oldest" or "newest" by accident of ASCII order.
	sort.SliceStable(events, func(i, j int) bool {
		ti, ierr := time.Parse(time.RFC3339, events[i].CreatedAt)
		tj, jerr := time.Parse(time.RFC3339, events[j].CreatedAt)
		switch {
		case ierr == nil && jerr == nil:
			return ti.After(tj)
		case ierr == nil:
			// i parsed, j did not: i sorts first (j is pushed to the end).
			return true
		default:
			// Either j parsed and i did not, or neither parsed: i does not
			// sort before j in either case.
			return false
		}
	})

	domainFailures := make([]domain.Failure, len(realFailures))
	for i, f := range realFailures {
		domainFailures[i] = domain.Failure{Source: f.Product, Message: f.Error}
	}

	return domain.Page{
		Events:         events,
		Failures:       domainFailures,
		NotImplemented: notImplemented,
	}, nil
}
