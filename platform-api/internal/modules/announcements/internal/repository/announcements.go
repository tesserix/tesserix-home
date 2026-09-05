// Package repository is the announcements module's data access.
package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/domain"
)

// Querier is a pool or a transaction.
//
// Taken by the write paths so they can run on the caller's transaction, which
// they always do: an announcement and its audit row must land together or not
// at all.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Active reads the published, in-window announcements addressed to a product
// and a tenant lifecycle status.
//
// # The filter is JSONB containment, and the NULL branches are load-bearing
//
// `audience_filter->'products'` absent means "every product", not "no
// product". Same for statuses. Dropping either NULL branch would silently
// hide every untargeted broadcast — which is most of them — and the symptom
// is an empty banner rather than an error.
//
// This is the query from apps/web's lib/db/platform-announcements.ts, moved
// rather than rewritten: it is the one the live rows were authored against.
func Active(ctx context.Context, pool *pgxpool.Pool, productID, tenantStatus string) ([]domain.Announcement, error) {
	rows, err := pool.Query(ctx,
		`SELECT id::text, title, body, severity, starts_at, ends_at
		   FROM platform_announcements
		  WHERE is_published = true
		    AND starts_at <= now()
		    AND (ends_at IS NULL OR ends_at > now())
		    AND (audience_filter->'products' IS NULL
		         OR audience_filter->'products' @> to_jsonb($1::text))
		    AND (audience_filter->'statuses' IS NULL
		         OR audience_filter->'statuses' @> to_jsonb($2::text))
		  ORDER BY starts_at DESC`,
		productID, tenantStatus)
	if err != nil {
		return nil, fmt.Errorf("reading announcements: %w", err)
	}
	defer rows.Close()

	out := make([]domain.Announcement, 0)
	for rows.Next() {
		var a domain.Announcement
		if err := rows.Scan(&a.ID, &a.Title, &a.Body, &a.Severity, &a.StartsAt, &a.EndsAt); err != nil {
			return nil, fmt.Errorf("scanning an announcement: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading announcements: %w", err)
	}
	// `out` was made with a length of 0 rather than declared nil, so an empty
	// result marshals as [] and not null. A client that got null where it
	// expected a list would be reading a bug in this API, not writing one.
	return out, nil
}

// ListAll reads every announcement, newest first, for the authoring surface.
//
// NO product or status filter and NO publication filter: an operator is
// choosing what to send and needs to see drafts, scheduled broadcasts and
// expired ones. That is the whole difference from Active, and it is why this
// is a separate query rather than Active with its predicates made optional —
// a filter that can be switched off is one accidental default away from
// serving drafts to a product.
func ListAll(ctx context.Context, db Querier, limit int) ([]domain.Authored, error) {
	rows, err := db.Query(ctx,
		`SELECT id::text, title, body, severity, starts_at, ends_at,
		        audience_filter, is_published, COALESCE(created_by, ''), updated_at
		   FROM platform_announcements
		  ORDER BY starts_at DESC
		  LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("reading announcements for authoring: %w", err)
	}
	defer rows.Close()

	out := make([]domain.Authored, 0)
	for rows.Next() {
		var a domain.Authored
		if err := rows.Scan(&a.ID, &a.Title, &a.Body, &a.Severity, &a.StartsAt, &a.EndsAt,
			&a.AudienceFilter, &a.IsPublished, &a.CreatedBy, &a.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scanning an announcement: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading announcements for authoring: %w", err)
	}
	return out, nil
}

// Insert creates an announcement and returns it as stored.
func Insert(ctx context.Context, db Querier, a domain.Authored, createdBy string) (domain.Authored, error) {
	row := db.QueryRow(ctx,
		`INSERT INTO platform_announcements
		   (title, body, severity, audience_filter, starts_at, ends_at, is_published, created_by)
		 VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8)
		 RETURNING id::text, title, body, severity, starts_at, ends_at,
		           audience_filter, is_published, COALESCE(created_by, ''), updated_at`,
		a.Title, a.Body, string(a.Severity), a.AudienceFilter,
		nilIfZero(a.StartsAt), a.EndsAt, a.IsPublished, createdBy)

	return scanAuthored(row)
}

// Update changes an announcement's mutable fields.
//
// Every argument is a POINTER, and nil means "leave alone". A struct of values
// would make "expire this" and "blank the end date" the same request, and the
// two are opposite intentions.
func Update(ctx context.Context, db Querier, id string, u UpdateFields) (domain.Authored, error) {
	row := db.QueryRow(ctx,
		`UPDATE platform_announcements
		    SET title        = COALESCE($2, title),
		        body         = COALESCE($3, body),
		        severity     = COALESCE($4, severity),
		        ends_at      = CASE WHEN $5::boolean THEN $6 ELSE ends_at END,
		        is_published = COALESCE($7, is_published)
		  WHERE id = $1::uuid
		  RETURNING id::text, title, body, severity, starts_at, ends_at,
		            audience_filter, is_published, COALESCE(created_by, ''), updated_at`,
		id, u.Title, u.Body, u.Severity, u.EndsAtSet, u.EndsAt, u.IsPublished)

	a, err := scanAuthored(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Authored{}, ErrNotFound
	}
	return a, err
}

// UpdateFields is a partial update. Nil means unchanged.
//
// EndsAtSet exists because `EndsAt = nil` is ambiguous on its own: it could
// mean "do not touch the end date" or "clear it, this runs indefinitely".
// The flag makes the caller say which.
type UpdateFields struct {
	Title       *string
	Body        *string
	Severity    *string
	EndsAtSet   bool
	EndsAt      *time.Time
	IsPublished *bool
}

// ErrNotFound is returned for an announcement that does not exist.
var ErrNotFound = errors.New("announcement not found")

func scanAuthored(row pgx.Row) (domain.Authored, error) {
	var a domain.Authored
	if err := row.Scan(&a.ID, &a.Title, &a.Body, &a.Severity, &a.StartsAt, &a.EndsAt,
		&a.AudienceFilter, &a.IsPublished, &a.CreatedBy, &a.UpdatedAt); err != nil {
		return domain.Authored{}, err
	}
	return a, nil
}

// nilIfZero lets the INSERT's COALESCE fall back to now() when no start was given.
func nilIfZero(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
