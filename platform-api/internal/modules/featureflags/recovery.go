package featureflags

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
)

func recoveryAllowed(c command, actor string, resume bool) *problem {
	if resume && c.Actor != actor {
		return &problem{403, "COMMAND_OWNER_REQUIRED", "Only the requesting operator can resume this change."}
	}
	if !resume && c.State != "queued" && c.Code != "CANCELED_BEFORE_DISPATCH" {
		return &problem{409, "COMMAND_ALREADY_DISPATCHED", "Only a change that has not been dispatched can be canceled."}
	}
	return nil
}

func (s service) recover(ctx context.Context, actor, id string, resume bool) (command, error) {
	if !requestKeyPattern.MatchString(id) {
		return command{}, &problem{400, "INVALID_COMMAND", "Provide a valid command identifier."}
	}
	c, err := scanCommand(s.journal.pool.QueryRow(ctx, `SELECT `+commandColumns+` FROM console_feature_flag_commands WHERE product='helivanta' AND id=$1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return command{}, &problem{404, "COMMAND_NOT_FOUND", "Feature flag command not found."}
	}
	if err != nil {
		return command{}, err
	}
	if issue := recoveryAllowed(c, actor, resume); issue != nil {
		return command{}, issue
	}
	if !resume {
		return s.journal.cancel(ctx, c, actor)
	}
	if c.State != "queued" {
		return c, nil
	}
	var key, revision string
	if err := s.journal.pool.QueryRow(ctx, `SELECT request_key::text,expected_revision FROM console_feature_flag_commands WHERE product='helivanta' AND id=$1::uuid`, id).Scan(&key, &revision); err != nil {
		return command{}, err
	}
	return s.apply(ctx, actor, key, change{Key: c.Key, Enabled: c.Enabled, ExpectedRevision: revision, Reason: c.Reason})
}

func (j journal) cancel(ctx context.Context, c command, actor string) (command, error) {
	if c.Code == "CANCELED_BEFORE_DISPATCH" {
		return c, nil
	}
	tx, err := j.pool.Begin(ctx)
	if err != nil {
		return command{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	updated, err := scanCommand(tx.QueryRow(ctx, `UPDATE console_feature_flag_commands SET state='failed',outcome_code='CANCELED_BEFORE_DISPATCH',updated_at=now() WHERE product='helivanta' AND id=$1::uuid AND state='queued' RETURNING `+commandColumns, c.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return command{}, &problem{409, "COMMAND_ALREADY_DISPATCHED", "The change was dispatched or canceled concurrently. Refresh its status."}
	}
	if err != nil {
		return command{}, err
	}
	if err := audit.Write(ctx, tx, audit.Entry{Actor: actor, Action: "feature_flags.canceled", Target: c.ID, Summary: map[string]int{"before_dispatch": 1}}); err != nil {
		return command{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return command{}, err
	}
	return updated, nil
}
