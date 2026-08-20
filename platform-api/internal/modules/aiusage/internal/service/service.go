package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/repository"
)

// Service answers the AI usage reads.
//
// It holds a clock because every read is relative to "now": a test that could
// not pin it would have to seed rows relative to wall-clock time and would fail
// at whichever hour boundary it happened to run across.
type Service struct {
	repo *repository.Repository
	now  func() time.Time
}

func New(pool *pgxpool.Pool) *Service {
	return NewWithClock(pool, func() time.Time { return time.Now().UTC() })
}

func NewWithClock(pool *pgxpool.Pool, now func() time.Time) *Service {
	return &Service{repo: repository.New(pool), now: now}
}

// Query is what every read is narrowed by.
type Query struct {
	Window   domain.Window
	Product  string
	Provider string
}

func (q Query) filter() repository.Filter {
	return repository.Filter{Product: q.Product, Provider: q.Provider}
}

func (s *Service) Summary(ctx context.Context, q Query) (SummaryPayload, error) {
	now := s.now().UTC()
	since := q.Window.Since(now)

	totals, err := s.repo.Totals(ctx, since, q.filter())
	if err != nil {
		return SummaryPayload{}, err
	}
	series, err := s.repo.Series(ctx, since, q.Window.Bucket, q.filter())
	if err != nil {
		return SummaryPayload{}, err
	}

	return SummaryPayload{
		Window: toWindow(q.Window, since, now),
		Totals: toTotals(totals),
		Series: toSeries(series),
	}, nil
}

func (s *Service) Breakdown(ctx context.Context, q Query, by domain.Dimension) (BreakdownPayload, error) {
	now := s.now().UTC()
	since := q.Window.Since(now)

	rows, err := s.repo.Breakdown(ctx, since, by, q.filter())
	if err != nil {
		return BreakdownPayload{}, err
	}
	return BreakdownPayload{
		Window: toWindow(q.Window, since, now),
		By:     string(by),
		Rows:   toBreakdown(rows),
	}, nil
}

func (s *Service) Guardrails(ctx context.Context, q Query) (GuardrailsPayload, error) {
	now := s.now().UTC()
	since := q.Window.Since(now)

	totals, err := s.repo.Totals(ctx, since, q.filter())
	if err != nil {
		return GuardrailsPayload{}, err
	}
	rules, err := s.repo.Guardrails(ctx, since, q.filter())
	if err != nil {
		return GuardrailsPayload{}, err
	}

	return GuardrailsPayload{
		Window:      toWindow(q.Window, since, now),
		Blocked:     totals.Blocked,
		Masked:      totals.Masked,
		RateLimited: totals.RateLimited,
		Rules:       toGuardrails(rules),
	}, nil
}

func (s *Service) Events(ctx context.Context, q Query, outcome domain.Outcome, limit int) (EventsPayload, error) {
	now := s.now().UTC()
	since := q.Window.Since(now)

	rows, err := s.repo.Events(ctx, since, limit, repository.EventFilter{
		Filter:  q.filter(),
		Outcome: outcome,
	})
	if err != nil {
		return EventsPayload{}, err
	}
	return EventsPayload{
		Window: toWindow(q.Window, since, now),
		Events: toEvents(rows),
	}, nil
}
