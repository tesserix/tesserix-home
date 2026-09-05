// Package repository is the announcements module's data access.
package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/domain"
)

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
