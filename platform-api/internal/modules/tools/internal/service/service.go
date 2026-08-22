// Package service is the tools module's operations over a pool.
package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/write"
)

// Service is the module's operations. Thin: the reads are one query and one
// mapping, and the writes are transaction scripts that need somewhere to live
// that is not an HTTP handler.
type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ErrRefused means the request was understood and the domain declined it —
// 422, distinct from a malformed request (400) and a missing row (404).
var ErrRefused = errors.New("the request was refused")

// ErrNotFound means the tool or group does not exist.
var ErrNotFound = errors.New("not found")

// ErrConflict means the row cannot be written as asked without displacing
// something else — a duplicate subdomain, or a group that still has tools.
var ErrConflict = errors.New("conflict")

// Tools reads the whole directory.
//
// Unpaginated, deliberately. See the handler's package comment.
func (s *Service) Tools(ctx context.Context) (ToolsPayload, error) {
	rows, err := repository.ListTools(ctx, s.pool)
	if err != nil {
		return ToolsPayload{}, err
	}
	return ToolsPayload{Tools: toolWires(rows)}, nil
}

// Groups reads every heading, in display order.
func (s *Service) Groups(ctx context.Context) (GroupsPayload, error) {
	rows, err := repository.ListGroups(ctx, s.pool)
	if err != nil {
		return GroupsPayload{}, err
	}
	return GroupsPayload{Groups: groupWires(rows)}, nil
}

// Actor is the principal performing a write, reduced to what an audit row
// needs.
type Actor struct {
	// Subject is the Zitadel `sub` — the audit trail's actor and the scope of
	// an idempotency key.
	Subject string
	// Email is what an operator recognises in the trail.
	Email string
}

// The audit trail's action names. Stable dotted identifiers, not prose: a
// retention or alerting rule discriminates on this column.
const (
	ActionToolCreated = "platform.tool.created"
	ActionToolUpdated = "platform.tool.updated"
	ActionToolDeleted = "platform.tool.deleted"

	ActionGroupCreated = "platform.tool_group.created"
	ActionGroupUpdated = "platform.tool_group.updated"
	ActionGroupDeleted = "platform.tool_group.deleted"
)

// The idempotency operation names, which scope a key to one kind of write. A
// key reused across two different operations is two different requests.
//
// EXPORTED because the handler passes them to readKey and lives in a different
// package. One spelling, declared once, rather than a second copy in handler.
const (
	OpToolCreate = "platform.tools.create"
	OpToolUpdate = "platform.tools.update"
	OpToolDelete = "platform.tools.delete"

	OpGroupCreate = "platform.tool_groups.create"
	OpGroupUpdate = "platform.tool_groups.update"
	OpGroupDelete = "platform.tool_groups.delete"
)

// ToolPatch is a partial change. Every field is a pointer so "absent" and
// "sent" are distinguishable; ClearNote carries the third state that a
// pointer alone cannot — an explicit null.
type ToolPatch struct {
	Name      *string
	Subdomain *string
	Purpose   *string
	GroupKey  *string
	Note      *string
	ClearNote bool
	SortOrder *int
}

// CreateTool adds a directory entry.
func (s *Service) CreateTool(ctx context.Context, actor Actor, tool domain.Tool,
	key *idempotency.Key,
) (write.Result, error) {
	// Normalised then validated, in that order: a note of spaces is not an
	// over-long note, and refusing it for its length would name the wrong
	// problem.
	tool = tool.Normalise()
	if err := tool.Validate(); err != nil {
		return write.Result{}, err
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		var order int
		if tool.SortOrder != nil {
			order = *tool.SortOrder
		} else {
			next, err := repository.NextSortOrder(ctx, tx, tool.GroupKey)
			if err != nil {
				return nil, audit.Entry{}, 0, err
			}
			order = next
		}

		stored, err := repository.InsertTool(ctx, tx, tool.Name, tool.Subdomain,
			tool.Purpose, tool.Note, tool.GroupKey, order)
		if err != nil {
			return nil, audit.Entry{}, 0, mapToolError(err)
		}

		return ToolPayload{Tool: toolWire(stored)},
			audit.Entry{
				Actor:  actor.Subject,
				Action: ActionToolCreated,
				Target: stored.ID,
				// Counts, never content. The purpose and the note are the
				// operator's own text and already live one table away.
				Summary: map[string]int{"tools": 1},
			},
			http.StatusCreated, nil
	})
}

// UpdateTool applies a partial change.
func (s *Service) UpdateTool(ctx context.Context, actor Actor, id string, patch ToolPatch,
	key *idempotency.Key,
) (write.Result, error) {
	// Validated as a whole only where a field was sent: a PATCH that changes
	// the purpose must not be refused for a subdomain it did not touch.
	if patch.Subdomain != nil || patch.Name != nil || patch.Purpose != nil ||
		patch.GroupKey != nil || patch.Note != nil || patch.SortOrder != nil {
		probe := domain.Tool{
			Name: "placeholder", Subdomain: "placeholder", Purpose: "placeholder",
			GroupKey: "placeholder",
		}
		if patch.Name != nil {
			probe.Name = *patch.Name
		}
		if patch.Subdomain != nil {
			probe.Subdomain = *patch.Subdomain
		}
		if patch.Purpose != nil {
			probe.Purpose = *patch.Purpose
		}
		if patch.GroupKey != nil {
			probe.GroupKey = *patch.GroupKey
		}
		probe.Note = patch.Note
		probe.SortOrder = patch.SortOrder

		probe = probe.Normalise()
		if err := probe.Validate(); err != nil {
			return write.Result{}, err
		}
		// Write back what normalisation changed, so the stored row is the
		// normalised one rather than the raw input.
		if patch.Name != nil {
			patch.Name = &probe.Name
		}
		if patch.Subdomain != nil {
			patch.Subdomain = &probe.Subdomain
		}
		if patch.Purpose != nil {
			patch.Purpose = &probe.Purpose
		}
		if patch.GroupKey != nil {
			patch.GroupKey = &probe.GroupKey
		}
		if patch.Note != nil {
			// Normalise() collapses a blank note ("" or "   ") to nil. If the
			// caller sent a note and it came back nil, that IS the caller
			// asking to clear it — not "leave it alone", which is what
			// writing nil into patch.Note while leaving ClearNote false would
			// do: the repository's CASE WHEN ClearNote THEN NULL ELSE
			// COALESCE(new, existing) END keeps the old note when neither
			// branch fires. Without this, `PATCH {"note": ""}` answers 200,
			// writes an audit row claiming an update, and the note never
			// changes.
			if probe.Note == nil {
				patch.Note, patch.ClearNote = nil, true
			} else {
				patch.Note = probe.Note
			}
		}
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		stored, err := repository.UpdateTool(ctx, tx, id, patch.Name, patch.Subdomain,
			patch.Purpose, patch.GroupKey, patch.Note, patch.ClearNote, patch.SortOrder)
		if err != nil {
			return nil, audit.Entry{}, 0, mapToolError(err)
		}
		return ToolPayload{Tool: toolWire(stored)},
			audit.Entry{Actor: actor.Subject, Action: ActionToolUpdated, Target: stored.ID,
				Summary: map[string]int{"tools": 1}},
			http.StatusOK, nil
	})
}

// DeleteTool removes a directory entry and answers with it as it was.
func (s *Service) DeleteTool(ctx context.Context, actor Actor, id string,
	key *idempotency.Key,
) (write.Result, error) {
	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		removed, err := repository.DeleteTool(ctx, tx, id)
		if err != nil {
			return nil, audit.Entry{}, 0, mapToolError(err)
		}
		return ToolPayload{Tool: toolWire(removed)},
			audit.Entry{Actor: actor.Subject, Action: ActionToolDeleted, Target: removed.ID,
				Summary: map[string]int{"tools": 1}},
			http.StatusOK, nil
	})
}

// mapToolError turns the repository's named constraints into this package's
// three outcomes, for a tool write.
//
// The distinction that matters: a duplicate subdomain is a CONFLICT because
// the request was valid and the directory's state refused it, while an unknown
// group is a REFUSAL because the caller named something that does not exist.
// A client retries the first after looking, and fixes the second.
func mapToolError(err error) error {
	switch {
	case errors.Is(err, repository.ErrNoRow):
		return fmt.Errorf("%w: no tool with this id", ErrNotFound)
	case errors.Is(err, repository.ErrDuplicateSubdomain):
		return fmt.Errorf("%w: %s", ErrConflict, err)
	case errors.Is(err, repository.ErrUnknownGroup):
		return fmt.Errorf("%w: %s — add the group first, or use one of the existing keys", ErrRefused, err)
	case errors.Is(err, repository.ErrGroupHasTools):
		return fmt.Errorf("%w: %s — move or remove them first", ErrConflict, err)
	case errors.Is(err, repository.ErrInvalidSubdomain):
		return fmt.Errorf("%w: %s", ErrRefused, err)
	}
	return err
}

// mapGroupError is mapToolError's near-copy for a group write. Identical but
// for the ErrNoRow message: "no group with this key" rather than "no tool
// with this id". A parameter that exists only to pick a noun is the worse
// shape than the duplication.
func mapGroupError(err error) error {
	switch {
	case errors.Is(err, repository.ErrNoRow):
		return fmt.Errorf("%w: no group with this key", ErrNotFound)
	case errors.Is(err, repository.ErrDuplicateGroup):
		return fmt.Errorf("%w: %s", ErrConflict, err)
	case errors.Is(err, repository.ErrUnknownGroup):
		return fmt.Errorf("%w: %s — add the group first, or use one of the existing keys", ErrRefused, err)
	case errors.Is(err, repository.ErrGroupHasTools):
		return fmt.Errorf("%w: %s — move or remove them first", ErrConflict, err)
	case errors.Is(err, repository.ErrInvalidSubdomain):
		return fmt.Errorf("%w: %s", ErrRefused, err)
	}
	return err
}

// GroupPatch is a partial change to a group. Key is intentionally absent — a
// group's key cannot be changed through this patch; see the handler.
type GroupPatch struct {
	Label     *string
	SortOrder *int
}

// CreateGroup adds a heading.
//
// SortOrder is wired through explicitly rather than dropped: the tool-create
// path already accepts a caller-chosen position, and a group that silently
// ignored the same field would be the odd one out — the exact failure
// updateGroupRequest.Key was designed to avoid, one field over.
func (s *Service) CreateGroup(ctx context.Context, actor Actor, key, label string, sortOrder *int,
	idemKey *idempotency.Key,
) (write.Result, error) {
	// Normalised then validated, in that order — see CreateTool.
	group := domain.Group{Key: key, Label: label, SortOrder: sortOrder}.Normalise()
	if err := group.Validate(); err != nil {
		return write.Result{}, err
	}

	return write.Perform(ctx, s.pool, idemKey, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		var order int
		if group.SortOrder != nil {
			order = *group.SortOrder
		} else {
			next, err := repository.NextGroupSortOrder(ctx, tx)
			if err != nil {
				return nil, audit.Entry{}, 0, err
			}
			order = next
		}

		stored, err := repository.InsertGroup(ctx, tx, group.Key, group.Label, order)
		if err != nil {
			return nil, audit.Entry{}, 0, mapGroupError(err)
		}

		return GroupPayload{Group: groupWire(stored)},
			audit.Entry{
				Actor:   actor.Subject,
				Action:  ActionGroupCreated,
				Target:  stored.Key,
				Summary: map[string]int{"groups": 1},
			},
			http.StatusCreated, nil
	})
}

// UpdateGroup applies a partial change.
func (s *Service) UpdateGroup(ctx context.Context, actor Actor, key string, patch GroupPatch,
	idemKey *idempotency.Key,
) (write.Result, error) {
	// Validated as a whole only where a field was sent — see UpdateTool.
	// The key is fixed to a placeholder that always satisfies the pattern:
	// this patch never carries a key, so the probe's key can never be what
	// fails validation.
	if patch.Label != nil || patch.SortOrder != nil {
		probe := domain.Group{Key: "placeholder", Label: "placeholder"}
		if patch.Label != nil {
			probe.Label = *patch.Label
		}
		probe.SortOrder = patch.SortOrder

		probe = probe.Normalise()
		if err := probe.Validate(); err != nil {
			return write.Result{}, err
		}
		if patch.Label != nil {
			patch.Label = &probe.Label
		}
		if patch.SortOrder != nil {
			patch.SortOrder = probe.SortOrder
		}
	}

	return write.Perform(ctx, s.pool, idemKey, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		stored, err := repository.UpdateGroup(ctx, tx, key, patch.Label, patch.SortOrder)
		if err != nil {
			return nil, audit.Entry{}, 0, mapGroupError(err)
		}
		return GroupPayload{Group: groupWire(stored)},
			audit.Entry{Actor: actor.Subject, Action: ActionGroupUpdated, Target: stored.Key,
				Summary: map[string]int{"groups": 1}},
			http.StatusOK, nil
	})
}

// DeleteGroup removes a heading and answers with it as it was.
func (s *Service) DeleteGroup(ctx context.Context, actor Actor, key string,
	idemKey *idempotency.Key,
) (write.Result, error) {
	return write.Perform(ctx, s.pool, idemKey, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		removed, err := repository.DeleteGroup(ctx, tx, key)
		if err != nil {
			return nil, audit.Entry{}, 0, mapGroupError(err)
		}
		return GroupPayload{Group: groupWire(removed)},
			audit.Entry{Actor: actor.Subject, Action: ActionGroupDeleted, Target: removed.Key,
				Summary: map[string]int{"groups": 1}},
			http.StatusOK, nil
	})
}
