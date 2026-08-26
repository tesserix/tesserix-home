// Package service composes the estate's billing view from every product that
// implements §8.2.
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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

const (
	subscriptionsPath = "/admin/billing/subscriptions"
	trialsPath        = "/admin/billing/trials"
)

// ErrNotInstrumented is the answer when no product declares §8.2.
//
// NOT the same as "no subscriptions". §8.2 is explicit that a product with no
// billing concept must not return an empty list to mean it, "that is
// indistinguishable from 'no subscriptions', which is a real and different
// answer" — and the same distinction has to survive one level up. An
// unconfigured estate must not be able to render as a solvent one with no
// customers.
var ErrNotInstrumented = errors.New("billing: no products implement the billing endpoints")

// ErrUnknownSource names a product this deployment cannot call.
var ErrUnknownSource = errors.New("billing: unknown source")

// Query is one read of either surface.
type Query struct {
	// Source narrows to one product; empty fans out across all of them.
	//
	// Fan-out is the DEFAULT here, unlike entities and kpis. §8.5's test —
	// can two products' rows sit in one table without a column meaning
	// something different in each? — passes cleanly: a plan, a status, an
	// amount in minor units and a period end mean the same thing whoever
	// issued them. §8.2's own framing is estate-shaped too: "which trials
	// expire this week, with dunning state, across tenants".
	Source string
	Limit  int
	// IncludeStripeManaged opts trials managed by Stripe back in. Products
	// exclude them by default; forwarded rather than decided here.
	IncludeStripeManaged bool
}

func (q Query) subscriptionsPath() string {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(q.Limit))
	return subscriptionsPath + "?" + params.Encode()
}

func (q Query) trialsPath() string {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(q.Limit))
	if q.IncludeStripeManaged {
		params.Set("include_stripe_managed", "true")
	}
	return trialsPath + "?" + params.Encode()
}

// Service reads the estate's billing surfaces.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. slugs is every product declaring §8.2.
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// resolve picks the products to ask, refusing an unknown one.
func (s *Service) resolve(source string) ([]string, error) {
	if len(s.slugs) == 0 {
		return nil, ErrNotInstrumented
	}
	if source == "" {
		return s.slugs, nil
	}
	for _, slug := range s.slugs {
		if slug == source {
			return []string{source}, nil
		}
	}
	// Refused rather than answered empty: a typo must not read as "that
	// product has no subscriptions", which is a real and different answer.
	return nil, fmt.Errorf("%w: %s", ErrUnknownSource, source)
}

// totals accumulates each product's own count.
//
// Guarded because federation.FanOut runs `decode` in ONE GOROUTINE PER SLUG
// (fanout.go:132) — not obvious at the call site, since the callback reads like
// ordinary sequential code, and an unguarded map write is a race that only
// shows up with more than one product configured.
type totals struct {
	mu  sync.Mutex
	sum int
}

func (t *totals) add(n int) {
	t.mu.Lock()
	t.sum += n
	t.mu.Unlock()
}

// Subscriptions reads every configured product's recurring plans.
func (s *Service) Subscriptions(
	ctx context.Context, op federation.Operator, q Query,
) (domain.SubscriptionPage, error) {
	slugs, err := s.resolve(q.Source)
	if err != nil {
		return domain.SubscriptionPage{}, err
	}

	var counted totals
	rows, failures := federation.FanOut(ctx, s.fed, slugs, q.subscriptionsPath(), op,
		func(slug string, body []byte) ([]domain.Subscription, error) {
			var envelope struct {
				Data       []domain.Subscription `json:"data"`
				Pagination struct {
					Total int `json:"total"`
				} `json:"pagination"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s subscriptions: %w", slug, err)
			}
			counted.add(envelope.Pagination.Total)
			// Stamped from the slug the call was MADE to: a product cannot
			// name itself into another product's revenue.
			for i := range envelope.Data {
				envelope.Data[i].Source = slug
			}
			return envelope.Data, nil
		})

	s.logFailures("subscriptions", failures)

	// Soonest renewal first — the ordering a revenue surface is read in. Rows
	// with no period end sort last rather than first: an unknown date is not
	// an imminent one, and putting it at the top would make it look urgent.
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i].CurrentPeriodEnd, rows[j].CurrentPeriodEnd
		if a == "" {
			return false
		}
		if b == "" {
			return true
		}
		return a < b
	})

	return domain.SubscriptionPage{
		Data:     nonNilSubscriptions(rows),
		Total:    counted.sum,
		Failures: toFailures(failures),
	}, nil
}

// Trials reads every configured product's expiring trials.
func (s *Service) Trials(
	ctx context.Context, op federation.Operator, q Query,
) (domain.TrialPage, error) {
	slugs, err := s.resolve(q.Source)
	if err != nil {
		return domain.TrialPage{}, err
	}

	var counted totals
	rows, failures := federation.FanOut(ctx, s.fed, slugs, q.trialsPath(), op,
		func(slug string, body []byte) ([]domain.Trial, error) {
			var envelope struct {
				Data       []domain.Trial `json:"data"`
				Pagination struct {
					Total int `json:"total"`
				} `json:"pagination"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s trials: %w", slug, err)
			}
			counted.add(envelope.Pagination.Total)
			for i := range envelope.Data {
				envelope.Data[i].Source = slug
			}
			return envelope.Data, nil
		})

	s.logFailures("trials", failures)

	// Fewest days remaining first. This is a work queue, not a report: the
	// trial ending soonest is the one somebody acts on today.
	sort.SliceStable(rows, func(i, j int) bool {
		return rows[i].DaysRemaining < rows[j].DaysRemaining
	})

	return domain.TrialPage{
		Data:     nonNilTrials(rows),
		Total:    counted.sum,
		Failures: toFailures(failures),
	}, nil
}

// logFailures records the unredacted cause. domain.Failure deliberately does
// not carry it — that is what reaches a browser.
func (s *Service) logFailures(surface string, failures []federation.Failure) {
	for _, f := range failures {
		s.log.Error("billing: federated source failed",
			"surface", surface, "source", f.Product, "error", f.Error, "cause", f.Unwrap())
	}
}

func toFailures(failures []federation.Failure) []domain.Failure {
	out := make([]domain.Failure, 0, len(failures))
	for _, f := range failures {
		out = append(out, domain.Failure{Source: f.Product, Message: f.Error})
	}
	return out
}

func nonNilSubscriptions(rows []domain.Subscription) []domain.Subscription {
	if rows == nil {
		return []domain.Subscription{}
	}
	return rows
}

func nonNilTrials(rows []domain.Trial) []domain.Trial {
	if rows == nil {
		return []domain.Trial{}
	}
	return rows
}
