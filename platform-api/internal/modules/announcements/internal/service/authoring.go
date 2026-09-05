package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/write"
)

// ErrRefused is a well-formed request the service declines. 422 at the edge.
var ErrRefused = errors.New("refused")

// maxTitle is apps/web's bound, copied. Both write the same column.
const maxTitle = 200

// defaultListLimit bounds the authoring list.
//
// Generous rather than paged: the estate has authored a handful of
// announcements in its lifetime, and a cursor here would be machinery for a
// page nobody will reach. If that changes, it changes visibly — the list stops
// at 200 rather than silently truncating one row.
const defaultListLimit = 200

// CreateInput is an announcement being authored.
type CreateInput struct {
	Title          string
	Body           string
	Severity       string
	AudienceFilter map[string]any
	StartsAt       *time.Time
	EndsAt         *time.Time
	// IsPublished is a DELIBERATE act, defaulting to false. Authoring and
	// sending are different things, and a create that published by default
	// would make every typo an irrevocable broadcast.
	IsPublished bool
}

// UpdateInput is a partial change. Nil means unchanged, throughout.
type UpdateInput struct {
	Title    *string
	Body     *string
	Severity *string
	// EndsAtSet distinguishes "clear the end date" from "leave it alone".
	// Without it, EndsAt = nil is both, and they are opposite intentions.
	EndsAtSet   bool
	EndsAt      *time.Time
	IsPublished *bool
}

func validateCreate(in CreateInput) (domain.Authored, error) {
	title := strings.TrimSpace(in.Title)
	body := strings.TrimSpace(in.Body)

	if title == "" {
		return domain.Authored{}, fmt.Errorf("%w: an announcement needs a title", ErrRefused)
	}
	if len(title) > maxTitle {
		return domain.Authored{}, fmt.Errorf("%w: a title is limited to %d characters", ErrRefused, maxTitle)
	}
	if body == "" {
		return domain.Authored{}, fmt.Errorf("%w: an announcement needs a body", ErrRefused)
	}

	severity, err := parseSeverity(in.Severity)
	if err != nil {
		return domain.Authored{}, err
	}

	if in.StartsAt != nil && in.EndsAt != nil && !in.EndsAt.After(*in.StartsAt) {
		// It would store fine and match nothing, so the operator would see a
		// successful send and no banner, with nothing to explain the gap.
		return domain.Authored{}, fmt.Errorf(
			"%w: the end of the window must be after its start", ErrRefused)
	}

	filter := in.AudienceFilter
	if filter == nil {
		// The column is NOT NULL DEFAULT '{}'. An empty object says
		// "untargeted" explicitly; a nil would insert NULL and be read as
		// untargeted by accident rather than by intent.
		filter = map[string]any{}
	}

	out := domain.Authored{
		Announcement: domain.Announcement{
			Title: title, Body: body, Severity: severity, EndsAt: in.EndsAt,
		},
		AudienceFilter: filter,
		IsPublished:    in.IsPublished,
	}
	if in.StartsAt != nil {
		out.StartsAt = *in.StartsAt
	}
	return out, nil
}

func validateUpdate(in UpdateInput) (repository.UpdateFields, error) {
	out := repository.UpdateFields{
		EndsAtSet: in.EndsAtSet, EndsAt: in.EndsAt, IsPublished: in.IsPublished,
	}
	if in.Title != nil {
		title := strings.TrimSpace(*in.Title)
		if title == "" || len(title) > maxTitle {
			return repository.UpdateFields{}, fmt.Errorf(
				"%w: a title must be between 1 and %d characters", ErrRefused, maxTitle)
		}
		out.Title = &title
	}
	if in.Body != nil {
		body := strings.TrimSpace(*in.Body)
		if body == "" {
			return repository.UpdateFields{}, fmt.Errorf("%w: a body cannot be empty", ErrRefused)
		}
		out.Body = &body
	}
	if in.Severity != nil {
		s, err := parseSeverity(*in.Severity)
		if err != nil {
			return repository.UpdateFields{}, err
		}
		str := string(s)
		out.Severity = &str
	}
	return out, nil
}

// parseSeverity narrows to the four values the CHECK constraint permits.
//
// Refused rather than defaulted: the column would reject an unknown value at
// INSERT, turning an operator's typo into a 500 for what is a 422.
func parseSeverity(raw string) (domain.Severity, error) {
	switch strings.TrimSpace(raw) {
	case "":
		return domain.SeverityInfo, nil
	case string(domain.SeverityInfo):
		return domain.SeverityInfo, nil
	case string(domain.SeverityWarning):
		return domain.SeverityWarning, nil
	case string(domain.SeverityMaintenance):
		return domain.SeverityMaintenance, nil
	case string(domain.SeverityIncident):
		return domain.SeverityIncident, nil
	}
	return "", fmt.Errorf("%w: severity must be one of info, warning, maintenance, incident", ErrRefused)
}

// ---- operations ---------------------------------------------------------

// AuthoredPayload is the authoring list on the wire.
type AuthoredPayload struct {
	Announcements []AuthoredAnnouncement `json:"announcements"`
}

// AuthoredAnnouncement carries the three fields a product never sees.
type AuthoredAnnouncement struct {
	Announcement
	AudienceFilter map[string]any `json:"audience_filter"`
	IsPublished    bool           `json:"is_published"`
	CreatedBy      string         `json:"created_by,omitempty"`
	UpdatedAt      time.Time      `json:"updated_at"`
}

// ListAuthored reads every announcement for the authoring surface.
func (s *Service) ListAuthored(ctx context.Context) (AuthoredPayload, error) {
	rows, err := repository.ListAll(ctx, s.pool, defaultListLimit)
	if err != nil {
		return AuthoredPayload{}, err
	}
	return AuthoredPayload{Announcements: toAuthoredWire(rows)}, nil
}

// Create authors an announcement.
func (s *Service) Create(ctx context.Context, actor string, in CreateInput, key *idempotency.Key) (write.Result, error) {
	draft, err := validateCreate(in)
	if err != nil {
		return write.Result{}, err
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		created, err := repository.Insert(ctx, tx, draft, actor)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}
		// The action distinguishes authoring from SENDING. A draft is
		// reversible and a published broadcast is not, and an audit trail that
		// called both "created" could not answer "what went out".
		action := "announcements.draft"
		if created.IsPublished {
			action = "announcements.publish"
		}
		return map[string]any{"announcement": toAuthoredOne(created)}, audit.Entry{
			Actor:   actor,
			Action:  action,
			Target:  created.ID,
			Summary: map[string]int{"announcements": 1},
		}, 201, nil
	})
}

// Update edits, publishes or expires an announcement.
func (s *Service) Update(ctx context.Context, actor, id string, in UpdateInput, key *idempotency.Key) (write.Result, error) {
	fields, err := validateUpdate(in)
	if err != nil {
		return write.Result{}, err
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		updated, err := repository.Update(ctx, tx, id, fields)
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}
		// Named from what was ASKED FOR, not from the resulting state: a row
		// that was already published and is edited again is not a second send,
		// and the trail should not read as though it were.
		action := "announcements.edit"
		switch {
		case fields.IsPublished != nil && *fields.IsPublished:
			action = "announcements.publish"
		case fields.EndsAtSet && fields.EndsAt != nil:
			action = "announcements.expire"
		}
		return map[string]any{"announcement": toAuthoredOne(updated)}, audit.Entry{
			Actor:   actor,
			Action:  action,
			Target:  updated.ID,
			Summary: map[string]int{"announcements": 1},
		}, 200, nil
	})
}

func toAuthoredOne(a domain.Authored) AuthoredAnnouncement {
	return AuthoredAnnouncement{
		Announcement: Announcement{
			ID: a.ID, Title: a.Title, Body: a.Body, Severity: string(a.Severity),
			StartsAt: a.StartsAt.UTC(), EndsAt: utcOrNil(a.EndsAt),
		},
		AudienceFilter: a.AudienceFilter,
		IsPublished:    a.IsPublished,
		CreatedBy:      a.CreatedBy,
		UpdatedAt:      a.UpdatedAt.UTC(),
	}
}

func toAuthoredWire(rows []domain.Authored) []AuthoredAnnouncement {
	out := make([]AuthoredAnnouncement, 0, len(rows))
	for _, a := range rows {
		out = append(out, toAuthoredOne(a))
	}
	return out
}
