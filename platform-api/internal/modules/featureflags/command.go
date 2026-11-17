package featureflags

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
)

var requestKeyPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var revisionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var errBusy = errors.New("another feature change is unresolved")
var errKeyReused = errors.New("idempotency key was used for a different change")

type change struct {
	Key              string `json:"key"`
	Enabled          bool   `json:"enabled"`
	ExpectedRevision string `json:"expected_revision"`
	Reason           string `json:"reason"`
}
type problem struct {
	Status        int
	Code, Message string
}

func (p *problem) Error() string { return p.Message }
func validateChange(v view, r change) *problem {
	if r.ExpectedRevision != v.Revision {
		return &problem{409, "STALE_FLAGS", "Feature flags changed. Refresh and review the impact again."}
	}
	for _, f := range v.Flags {
		if f.Key != r.Key {
			continue
		}
		if r.Enabled && !f.Eligible {
			return &problem{422, "FEATURE_NOT_RELEASED", "This feature is not eligible in the approved release."}
		}
		if r.Enabled && len(f.BlockedBy) > 0 {
			return &problem{409, "DEPENDENCIES_DISABLED", "Enable the required prerequisites first."}
		}
		return nil
	}
	return &problem{404, "FLAG_NOT_FOUND", "Feature flag not found."}
}
func validateRequest(key string, r change) *problem {
	if !requestKeyPattern.MatchString(key) || !flagKey.MatchString(r.Key) || !revisionPattern.MatchString(r.ExpectedRevision) || !utf8.ValidString(r.Reason) || utf8.RuneCountInString(strings.TrimSpace(r.Reason)) < 8 || utf8.RuneCountInString(r.Reason) > 500 {
		return &problem{400, "INVALID_CHANGE", "Provide a valid request key, revision and reason of 8–500 characters."}
	}
	for _, ch := range r.Reason {
		if unicode.IsControl(ch) {
			return &problem{400, "INVALID_CHANGE", "The reason must be a single line of text."}
		}
	}
	return nil
}
func digestChange(r change) string {
	data, _ := json.Marshal(r)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

type command struct {
	ID              string    `json:"id"`
	Actor           string    `json:"actor"`
	Key             string    `json:"key"`
	Enabled         bool      `json:"enabled"`
	Reason          string    `json:"reason"`
	State           string    `json:"state"`
	Code            string    `json:"code"`
	ProviderVersion *int      `json:"provider_version"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	requestHash     string
	baseVersion     int
}

const commandColumns = `id::text, actor, flag_key, desired, reason, state, outcome_code, provider_version, created_at, updated_at, request_hash, base_version`

func scanCommand(row pgx.Row) (command, error) {
	var c command
	err := row.Scan(&c.ID, &c.Actor, &c.Key, &c.Enabled, &c.Reason, &c.State, &c.Code, &c.ProviderVersion, &c.CreatedAt, &c.UpdatedAt, &c.requestHash, &c.baseVersion)
	return c, err
}

type journal struct{ pool *pgxpool.Pool }

func (j journal) find(ctx context.Context, actor, key string) (command, error) {
	return scanCommand(j.pool.QueryRow(ctx, `SELECT `+commandColumns+` FROM console_feature_flag_commands WHERE product='helivanta' AND actor=$1 AND request_key=$2::uuid`, actor, key))
}
func (j journal) recent(ctx context.Context) ([]command, error) {
	rows, err := j.pool.Query(ctx, `SELECT `+commandColumns+` FROM console_feature_flag_commands WHERE product='helivanta' ORDER BY created_at DESC,id DESC LIMIT 20`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []command{}
	for rows.Next() {
		c, err := scanCommand(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (j journal) reserve(ctx context.Context, actor, key string, r change, baseVersion int) (command, bool, error) {
	tx, err := j.pool.Begin(ctx)
	if err != nil {
		return command{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	c, err := scanCommand(tx.QueryRow(ctx, `INSERT INTO console_feature_flag_commands (product,actor,request_key,request_hash,flag_key,desired,expected_revision,base_version,reason,state) VALUES ('helivanta',$1,$2::uuid,$3,$4,$5,$6,$7,$8,'queued') RETURNING `+commandColumns, actor, key, digestChange(r), r.Key, r.Enabled, r.ExpectedRevision, baseVersion, r.Reason))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			_ = tx.Rollback(ctx)
			existing, lookupErr := j.find(ctx, actor, key)
			if lookupErr == nil {
				if existing.requestHash != digestChange(r) {
					return command{}, false, errKeyReused
				}
				return existing, false, nil
			}
			if errors.Is(lookupErr, pgx.ErrNoRows) {
				return command{}, false, errBusy
			}
			return command{}, false, lookupErr
		}
		return command{}, false, err
	}
	enabled := 0
	if r.Enabled {
		enabled = 1
	}
	if err = audit.Write(ctx, tx, audit.Entry{Actor: actor, Action: "feature_flags.requested", Target: c.ID, Summary: map[string]int{"enabled": enabled}}); err != nil {
		return command{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return command{}, false, err
	}
	return c, true, nil
}
func (j journal) dispatch(ctx context.Context, id string) (command, error) {
	return scanCommand(j.pool.QueryRow(ctx, `UPDATE console_feature_flag_commands SET state='dispatching',updated_at=now() WHERE id=$1::uuid AND product='helivanta' AND state='queued' RETURNING `+commandColumns, id))
}
func (j journal) finish(ctx context.Context, c command, state, code string, version *int) (command, error) {
	tx, err := j.pool.Begin(ctx)
	if err != nil {
		return command{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	updated, err := scanCommand(tx.QueryRow(ctx, `UPDATE console_feature_flag_commands SET state=$2,outcome_code=$3,provider_version=$4,updated_at=now() WHERE id=$1::uuid AND product='helivanta' AND state IN ('queued','dispatching','in_doubt') RETURNING `+commandColumns, c.ID, state, code, version))
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return scanCommand(j.pool.QueryRow(ctx, `SELECT `+commandColumns+` FROM console_feature_flag_commands WHERE id=$1::uuid AND product='helivanta'`, c.ID))
	}
	if err != nil {
		return command{}, err
	}
	if err = audit.Write(ctx, tx, audit.Entry{Actor: c.Actor, Action: "feature_flags." + state, Target: c.ID, Summary: map[string]int{"recorded": 1}}); err != nil {
		return command{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return command{}, err
	}
	return updated, nil
}
func commandStatus(c command) int {
	if c.State == "queued" || c.State == "dispatching" || c.State == "in_doubt" {
		return http.StatusAccepted
	}
	return http.StatusOK
}
