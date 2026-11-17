package featureflags

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type service struct {
	provider *provider
	journal  journal
}

func (s service) read(ctx context.Context) (view, error) {
	v, err := s.provider.load(ctx)
	if err != nil {
		return view{}, err
	}
	commands, err := s.journal.recent(ctx)
	if err != nil {
		return view{}, err
	}
	reconciled := false
	for i, c := range commands {
		if c.State != "in_doubt" && (c.State != "dispatching" || time.Since(c.UpdatedAt) < 10*time.Second) {
			continue
		}
		f, inspectErr := s.provider.inspect(ctx, c.Key)
		if inspectErr != nil || f.Revision.Version <= c.baseVersion || f.Revision.Comment != "Tesserix command "+c.ID+": "+c.Reason {
			continue
		}
		enabled, valueErr := s.provider.value(f)
		if valueErr != nil || enabled != c.Enabled {
			continue
		}
		settled, finishErr := s.journal.finish(ctx, c, "succeeded", "CONFIRMED", &f.Revision.Version)
		if finishErr != nil {
			return view{}, finishErr
		}
		commands[i] = settled
		reconciled = true
	}
	if reconciled {
		v, err = s.provider.load(ctx)
		if err != nil {
			return view{}, err
		}
	}
	v.Commands = commands
	return v, nil
}
func (s service) apply(ctx context.Context, actor, key string, r change) (command, error) {
	if err := validateRequest(key, r); err != nil {
		return command{}, err
	}
	existing, err := s.journal.find(ctx, actor, key)
	if err == nil {
		if existing.requestHash != digestChange(r) {
			return command{}, errKeyReused
		}
		if existing.State == "queued" {
			return s.run(ctx, existing, r)
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return command{}, err
	}
	v, err := s.provider.load(ctx)
	if err != nil {
		return command{}, err
	}
	if err := validateChange(v, r); err != nil {
		return command{}, err
	}
	c, created, err := s.journal.reserve(ctx, actor, key, r, v.features[r.Key].Revision.Version)
	if err != nil {
		return command{}, err
	}
	if !created {
		if c.State == "queued" {
			return s.run(ctx, c, r)
		}
		return c, nil
	}
	return s.run(ctx, c, r)
}
func (s service) run(ctx context.Context, c command, r change) (command, error) {
	claimed, err := s.journal.dispatch(ctx, c.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return scanCommand(s.journal.pool.QueryRow(ctx, `SELECT `+commandColumns+` FROM console_feature_flag_commands WHERE id=$1::uuid AND product='helivanta'`, c.ID))
	}
	if err != nil {
		return command{}, err
	}
	c = claimed
	finish := func(state, code string, version *int) (command, error) {
		recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		return s.journal.finish(recordCtx, c, state, code, version)
	}
	// Recheck after reserving the product: another completed command may have
	// changed the provider between our first read and the durable reservation.
	current, err := s.provider.load(ctx)
	if err != nil {
		return finish("failed", "PROVIDER_UNAVAILABLE", nil)
	}
	if problem := validateChange(current, r); problem != nil {
		return finish("failed", problem.Code, nil)
	}
	for _, f := range current.Flags {
		if f.Key == r.Key && f.Enabled == r.Enabled {
			version := current.features[r.Key].Revision.Version
			return finish("succeeded", "ALREADY_SET", &version)
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	published, err := s.provider.publish(callCtx, r.Key, r.Enabled, c.ID, r.Reason)
	cancel()
	if errors.Is(err, errNotSent) {
		return finish("failed", "PROVIDER_UNAVAILABLE", nil)
	}
	if errors.Is(err, errProviderRefused) {
		return finish("failed", "PROVIDER_REFUSED", nil)
	}
	if err != nil {
		return finish("in_doubt", "OUTCOME_UNKNOWN", nil)
	}
	if published.Revision.Version <= c.baseVersion {
		return finish("in_doubt", "OUTCOME_UNKNOWN", nil)
	}
	return finish("succeeded", "CONFIRMED", &published.Revision.Version)
}
