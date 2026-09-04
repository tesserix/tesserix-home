package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/write"
)

// Bounds on a filing.
//
// Copied from the zod schema on apps/web's internal create route, not chosen
// here: both write the same columns for the same product, and a limit
// tightened on the way across would reject filings that succeed today.
//
// The description has NO bound, matching apps/web. It is not unbounded in
// practice — maxBodyBytes caps the request through MaxBytesReader — and
// inventing a field limit here would reject filings apps/web accepts.
const (
	maxSubject         = 300
	maxSubmitterName   = 200
	maxSubmitterEmail  = 300
	maxSubmitterUserID = 200
)

// CreateInput is a ticket a product is filing on a merchant's behalf.
//
// There is no ProductID. It comes from the scope the registry resolved, never
// from the request — a product filing into another product's queue is the leak
// #152 exists to close, and a field the caller could set would be exactly that.
type CreateInput struct {
	Subject           string
	Description       string
	Priority          string
	SubmittedByName   string
	SubmittedByEmail  string
	SubmittedByUserID string
}

// validCreate is a filing that has passed the boundary checks.
type validCreate struct {
	Subject           string
	Description       string
	Priority          domain.Priority
	SubmittedByName   string
	SubmittedByEmail  string
	SubmittedByUserID string
}

// validateCreate checks a filing and normalises it.
//
// Pure, so the rules are checked wherever the tests run rather than only where
// a postgres is configured.
//
// Everything is trimmed BEFORE it is measured, so a subject of spaces is an
// absent subject rather than a 3-character one.
func validateCreate(in CreateInput) (validCreate, error) {
	out := validCreate{
		Subject:           strings.TrimSpace(in.Subject),
		Description:       strings.TrimSpace(in.Description),
		SubmittedByName:   strings.TrimSpace(in.SubmittedByName),
		SubmittedByEmail:  strings.TrimSpace(in.SubmittedByEmail),
		SubmittedByUserID: strings.TrimSpace(in.SubmittedByUserID),
	}

	if out.Subject == "" {
		return validCreate{}, fmt.Errorf("%w: a ticket needs a subject", ErrRefused)
	}
	if len(out.Subject) > maxSubject {
		return validCreate{}, fmt.Errorf("%w: a subject is limited to %d characters", ErrRefused, maxSubject)
	}
	if out.Description == "" {
		return validCreate{}, fmt.Errorf("%w: a ticket needs a description", ErrRefused)
	}

	// A filing needs a reachable submitter — a support request nobody can
	// answer is not a support request. Both are required here, unlike a
	// reply's author email, and that asymmetry is apps/web's rather than an
	// oversight.
	if out.SubmittedByName == "" {
		return validCreate{}, fmt.Errorf("%w: a ticket needs the submitter's name", ErrRefused)
	}
	if len(out.SubmittedByName) > maxSubmitterName {
		return validCreate{}, fmt.Errorf("%w: a submitter name is limited to %d characters", ErrRefused, maxSubmitterName)
	}
	// Deliberately lighter than RFC 5322, and lighter than zod's `.email()`.
	// The check that matters is that the address is present and plausibly an
	// address; a stricter rule here than apps/web's would reject filings it
	// accepts, which is the wrong direction for a migration to fail in.
	if !plausibleEmail(out.SubmittedByEmail) {
		return validCreate{}, fmt.Errorf("%w: a ticket needs the submitter's email address", ErrRefused)
	}
	if len(out.SubmittedByEmail) > maxSubmitterEmail {
		return validCreate{}, fmt.Errorf("%w: a submitter email is limited to %d characters", ErrRefused, maxSubmitterEmail)
	}
	if len(out.SubmittedByUserID) > maxSubmitterUserID {
		return validCreate{}, fmt.Errorf("%w: a submitter user id is limited to %d characters", ErrRefused, maxSubmitterUserID)
	}

	// An unrecognised priority is REFUSED, never defaulted. Defaulting would
	// file an "urgant" ticket as medium and the merchant who typed it would
	// never learn their urgency had been dropped.
	if in.Priority == "" {
		out.Priority = domain.PriorityMedium
	} else {
		p, err := domain.ParsePriority(in.Priority)
		if err != nil {
			return validCreate{}, fmt.Errorf("%w: %s", ErrRefused, err)
		}
		out.Priority = p
	}

	return out, nil
}

func plausibleEmail(address string) bool {
	at := strings.IndexByte(address, '@')
	return at > 0 && at < len(address)-1 && !strings.ContainsAny(address, " \t\n")
}

// Create files a ticket for the product the caller speaks for.
//
// Scoped callers only: the product and tenant both come from the scope, so an
// unscoped principal has no queue to file into. The handler refuses an
// operator before reaching this.
func (s *Service) Create(ctx context.Context, scope Scope, actor Actor, in CreateInput, key *idempotency.Key) (write.Result, error) {
	if scope.Unscoped() {
		return write.Result{}, fmt.Errorf("%w: filing a ticket needs a product to file it against", ErrRefused)
	}

	valid, err := validateCreate(in)
	if err != nil {
		return write.Result{}, err
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		created, err := repository.Insert(ctx, tx, repository.NewTicket{
			// From the SCOPE, never the request.
			ProductID:         scope.ProductID,
			TenantID:          scope.TenantID,
			Subject:           valid.Subject,
			Description:       valid.Description,
			Priority:          valid.Priority,
			SubmittedByName:   valid.SubmittedByName,
			SubmittedByEmail:  valid.SubmittedByEmail,
			SubmittedByUserID: valid.SubmittedByUserID,
		})
		if err != nil {
			return nil, audit.Entry{}, 0, err
		}

		return CreatePayload{Ticket: toTicket(created)}, audit.Entry{
			Actor:  actor.Subject,
			Action: "tickets.create",
			Target: created.ID,
			// Counts only, never content: a subject and a description are the
			// merchant's words, and an audit row that copies them is a second
			// copy of the data with a longer retention.
			Summary: map[string]int{"tickets": 1},
		}, 201, nil
	})
}
