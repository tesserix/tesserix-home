package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/repository"
)

// Service is the CRM queues module's operations over a pool.
//
// Thin, deliberately: both reads are one repository call and one mapping. It
// exists rather than letting the handler call the repository directly for two
// reasons — the wire types live here and the handler should not learn the
// domain's shape, and Task 5's write needs a transaction script to live
// somewhere that is not an HTTP handler.
type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// Due reads one page of the opportunities whose next action has arrived.
//
// The repository.Page is returned ALONGSIDE the payload rather than folded
// into it, because its counts and cursors belong in the envelope's `meta`, not
// in `data`. A payload carrying its own pagination would be a second place for
// a client to look for it.
func (s *Service) Due(ctx context.Context, filter domain.Filter, limit int, cursor string) (QueuePayload, repository.Page, error) {
	page, err := repository.Due(ctx, s.pool, filter, limit, cursor)
	if err != nil {
		return QueuePayload{}, repository.Page{}, err
	}
	return QueuePayload{Opportunities: toOpportunities(page.Opportunities)}, page, nil
}

// Drifting reads one page of the opportunities that have gone quiet with
// nothing scheduled.
func (s *Service) Drifting(ctx context.Context, filter domain.Filter, staleDays, limit int, cursor string) (QueuePayload, repository.Page, error) {
	page, err := repository.Drifting(ctx, s.pool, filter, staleDays, limit, cursor)
	if err != nil {
		return QueuePayload{}, repository.Page{}, err
	}
	return QueuePayload{Opportunities: toOpportunities(page.Opportunities)}, page, nil
}
