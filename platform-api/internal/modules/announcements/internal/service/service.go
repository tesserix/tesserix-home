// Package service holds the announcements module's operation and the shape it
// answers with.
package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/repository"
)

// Announcement is one broadcast on the wire.
//
// snake_case, the estate's spelling and what mark8ly's existing parser already
// reads. The field set is what a product RENDERS — its banner uses id,
// severity, title and body — plus the schedule, which lets a client order or
// expire without a second call. See domain.Announcement for what is left out
// and why.
type Announcement struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Body     string    `json:"body"`
	Severity string    `json:"severity"`
	StartsAt time.Time `json:"starts_at"`
	// EndsAt is null for a broadcast with no scheduled end, rather than absent:
	// a client can then tell "runs indefinitely" from "the field was not sent".
	EndsAt *time.Time `json:"ends_at"`
}

// ListPayload is the answer to a read.
type ListPayload struct {
	Announcements []Announcement `json:"announcements"`
}

// Service reads announcements over a pool, and previews their audience over
// whatever TenantSource the composition root supplies.
type Service struct {
	pool *pgxpool.Pool
	// tenants may be nil where the audience preview is not wired. Audience is
	// the only method that touches it.
	tenants TenantSource
}

func New(pool *pgxpool.Pool, tenants TenantSource) *Service {
	return &Service{pool: pool, tenants: tenants}
}

// Active reads what a product should show a merchant in the given lifecycle
// status.
//
// productID comes from the CALLER'S SCOPE, never from the request — the same
// rule as the tickets module, and for the same reason: a product asking for
// another product's broadcasts would be asking about an audience it is not in.
func (s *Service) Active(ctx context.Context, productID, tenantStatus string) (ListPayload, error) {
	rows, err := repository.Active(ctx, s.pool, productID, tenantStatus)
	if err != nil {
		return ListPayload{}, err
	}
	return ListPayload{Announcements: toWire(rows)}, nil
}

func toWire(rows []domain.Announcement) []Announcement {
	out := make([]Announcement, 0, len(rows))
	for _, a := range rows {
		out = append(out, Announcement{
			ID:       a.ID,
			Title:    a.Title,
			Body:     a.Body,
			Severity: string(a.Severity),
			StartsAt: a.StartsAt.UTC(),
			EndsAt:   utcOrNil(a.EndsAt),
		})
	}
	return out
}

// utcOrNil normalises a nullable timestamp.
//
// UTC on the way out, matching every other module: pgx decodes into
// time.Local, so a server in another zone would otherwise answer the same
// instant with a different offset.
func utcOrNil(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}
