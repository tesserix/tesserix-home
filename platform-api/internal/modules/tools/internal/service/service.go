// Package service is the tools module's operations over a pool.
package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/repository"
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
