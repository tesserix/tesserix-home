// Package repository is the tools module's SQL, and the only place it lives.
//
// Under modules/tools/internal/, so only code rooted at modules/tools/ can
// import it.
package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Queryer is what this package needs from a pool or a transaction.
//
// An interface rather than *pgxpool.Pool so the reads work inside
// write.Perform's transaction as well as outside one — a write that answers
// with the row it just changed must read it through the same transaction, or
// it answers with what was there before.
type Queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Tool is one row of the directory.
type Tool struct {
	ID        string
	Name      string
	Subdomain string
	Purpose   string
	// Note is absent for most tools. A pointer rather than a string because
	// "" and "no note" are different things on the wire: the console renders
	// nothing for absence and would render an empty line for "".
	Note      *string
	GroupKey  string
	SortOrder int
}

// Group is one heading, and the vocabulary a Tool's GroupKey must name.
type Group struct {
	Key       string
	Label     string
	SortOrder int
}

// ListGroups returns every group in display order.
func ListGroups(ctx context.Context, q Queryer) ([]Group, error) {
	rows, err := q.Query(ctx,
		`SELECT key, label, sort_order FROM platform_tool_groups ORDER BY sort_order, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil so an empty table marshals as [] rather than null.
	groups := []Group{}
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.Key, &g.Label, &g.SortOrder); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

// ListTools returns every tool, ordered by its group's position and then its
// own — the order the page renders in, decided here rather than in the
// renderer so both consumers get the same one.
func ListTools(ctx context.Context, q Queryer) ([]Tool, error) {
	rows, err := q.Query(ctx,
		`SELECT t.id, t.name, t.subdomain, t.purpose, t.note, t.group_key, t.sort_order
		   FROM platform_tools t
		   JOIN platform_tool_groups g ON g.key = t.group_key
		  ORDER BY g.sort_order, t.sort_order, t.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tools := []Tool{}
	for rows.Next() {
		var t Tool
		if err := rows.Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note,
			&t.GroupKey, &t.SortOrder); err != nil {
			return nil, err
		}
		tools = append(tools, t)
	}
	return tools, rows.Err()
}

// Execer is a Queryer that also writes. The writes take a transaction, never a
// pool: they are performed inside write.Perform so the row, its audit entry
// and its idempotency record commit together or not at all.
type Execer interface {
	Queryer
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// ErrNoRow is returned when a write addressed a row that is not there.
// Distinguished here rather than at the call site because pgx.ErrNoRows means
// the same thing for a read that legitimately found nothing.
var ErrNoRow = errors.New("no such row")

// ErrDuplicateSubdomain is the unique constraint, named.
var ErrDuplicateSubdomain = errors.New("a tool with this subdomain already exists")

// ErrUnknownGroup is the foreign key, named.
var ErrUnknownGroup = errors.New("no group with this key exists")

// ErrGroupHasTools is ON DELETE RESTRICT, named.
//
// Never returned by classify: migration 0031 defines exactly ONE foreign key,
// platform_tools_group_key_fkey, and Postgres reports that same constraint
// name whether an INSERT/UPDATE named a group that does not exist or a DELETE
// tried to remove a group something still references. The two are
// indistinguishable from the error alone — the direction is known at the
// CALL SITE and nowhere else. The group-delete path (Task 5) raises this
// sentinel itself rather than going through classify.
var ErrGroupHasTools = errors.New("the group still has tools in it")

// ErrInvalidSubdomain is the CHECK constraint, named.
var ErrInvalidSubdomain = errors.New("a subdomain must be a single DNS label")

// classify turns a Postgres error into one of this package's sentinels.
//
// By CONSTRAINT NAME rather than by SQLSTATE alone: 23505 covers more than one
// constraint on these tables, and a caller told "already exists" for the
// wrong one would go and change the wrong field. 23503 has only one
// constraint to name, but two directions it can be raised in — see
// ErrGroupHasTools for why that case cannot be split here.
func classify(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch {
	case pgErr.Code == "23505" && strings.Contains(pgErr.ConstraintName, "subdomain"):
		return ErrDuplicateSubdomain
	case pgErr.Code == "23503":
		// The one foreign key this schema has, in the INSERT/UPDATE
		// direction only — a caller named a group that does not exist. The
		// other direction (deleting a group that still has tools) reports
		// the identical constraint name and cannot be told apart here; the
		// group-delete path raises ErrGroupHasTools itself instead of
		// relying on classify.
		return ErrUnknownGroup
	case pgErr.Code == "23514" && strings.Contains(pgErr.ConstraintName, "dns_label"):
		// Reachable only if domain.SubdomainPattern and the CHECK have
		// drifted. Named anyway: a 500 carrying a constraint name is a worse
		// answer than a 422 saying what a subdomain must look like, even when
		// the API should have caught it first.
		return ErrInvalidSubdomain
	case pgErr.Code == "22P02":
		// A malformed uuid in the path. 404 is the honest answer: there is no
		// row with that identifier, and 500 would blame the service for the
		// caller's typo.
		return ErrNoRow
	}
	return err
}

// NextSortOrder is the position a new entry takes in its group: the end.
//
// Computed rather than defaulted to zero, which would silently make every new
// tool the first one in its group.
func NextSortOrder(ctx context.Context, q Queryer, groupKey string) (int, error) {
	var next int
	err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platform_tools WHERE group_key = $1`,
		groupKey).Scan(&next)
	return next, err
}

// InsertTool adds an entry and returns it as stored.
func InsertTool(ctx context.Context, e Execer, name, subdomain, purpose string,
	note *string, groupKey string, sortOrder int,
) (Tool, error) {
	var t Tool
	err := e.QueryRow(ctx,
		`INSERT INTO platform_tools (name, subdomain, purpose, note, group_key, sort_order)
		      VALUES ($1, $2, $3, $4, $5, $6)
		   RETURNING id, name, subdomain, purpose, note, group_key, sort_order`,
		name, subdomain, purpose, note, groupKey, sortOrder).
		Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note, &t.GroupKey, &t.SortOrder)
	if err != nil {
		return Tool{}, classify(err)
	}
	return t, nil
}

// UpdateTool applies a partial change. A nil argument leaves the column alone;
// clearing the note is a non-nil pointer to a nil string, which is why
// clearNote is separate — SQL has no way to spell "set this to NULL" and
// "leave it" with one parameter.
func UpdateTool(ctx context.Context, e Execer, id string,
	name, subdomain, purpose, groupKey *string, note *string, clearNote bool, sortOrder *int,
) (Tool, error) {
	var t Tool
	err := e.QueryRow(ctx,
		`UPDATE platform_tools
		    SET name       = COALESCE($2, name),
		        subdomain  = COALESCE($3, subdomain),
		        purpose    = COALESCE($4, purpose),
		        group_key  = COALESCE($5, group_key),
		        note       = CASE WHEN $7 THEN NULL ELSE COALESCE($6, note) END,
		        sort_order = COALESCE($8, sort_order),
		        updated_at = now()
		  WHERE id = $1
		RETURNING id, name, subdomain, purpose, note, group_key, sort_order`,
		id, name, subdomain, purpose, groupKey, note, clearNote, sortOrder).
		Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note, &t.GroupKey, &t.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tool{}, ErrNoRow
	}
	if err != nil {
		return Tool{}, classify(err)
	}
	return t, nil
}

// DeleteTool removes an entry and returns it as it was, so the write can
// answer with what it removed.
func DeleteTool(ctx context.Context, e Execer, id string) (Tool, error) {
	var t Tool
	err := e.QueryRow(ctx,
		`DELETE FROM platform_tools WHERE id = $1
		 RETURNING id, name, subdomain, purpose, note, group_key, sort_order`, id).
		Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note, &t.GroupKey, &t.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tool{}, ErrNoRow
	}
	if err != nil {
		return Tool{}, classify(err)
	}
	return t, nil
}

// NextGroupSortOrder is the position a new group takes: after the existing
// ones. A new group must not silently displace identity from the top.
func NextGroupSortOrder(ctx context.Context, q Queryer) (int, error) {
	var next int
	err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platform_tool_groups`).Scan(&next)
	return next, err
}

// InsertGroup adds a heading.
func InsertGroup(ctx context.Context, e Execer, key, label string, sortOrder int) (Group, error) {
	var g Group
	err := e.QueryRow(ctx,
		`INSERT INTO platform_tool_groups (key, label, sort_order) VALUES ($1, $2, $3)
		 RETURNING key, label, sort_order`, key, label, sortOrder).
		Scan(&g.Key, &g.Label, &g.SortOrder)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Group{}, ErrDuplicateGroup
		}
		return Group{}, err
	}
	return g, nil
}

// ErrDuplicateGroup is the group primary key, named.
var ErrDuplicateGroup = errors.New("a group with this key already exists")

// UpdateGroup changes a heading's label or position. The KEY is not
// changeable — see the handler.
func UpdateGroup(ctx context.Context, e Execer, key string, label *string, sortOrder *int) (Group, error) {
	var g Group
	err := e.QueryRow(ctx,
		`UPDATE platform_tool_groups
		    SET label      = COALESCE($2, label),
		        sort_order = COALESCE($3, sort_order),
		        updated_at = now()
		  WHERE key = $1
		RETURNING key, label, sort_order`, key, label, sortOrder).
		Scan(&g.Key, &g.Label, &g.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Group{}, ErrNoRow
	}
	return g, err
}

// DeleteGroup removes a heading, and is refused by the foreign key if any tool
// still references it.
//
// It maps 23503 ITSELF rather than deferring to classify, and that is the whole
// point of this function having its own error handling. Migration 0031 defines
// exactly one foreign key, `platform_tools_group_key_fkey`, and Postgres reports
// that same constraint name in BOTH directions — inserting a tool into a group
// that does not exist, and deleting a group that still has tools. Neither the
// constraint name nor the table name distinguishes them. The DIRECTION is known
// here at the call site and nowhere else, so this is the only place the
// distinction can be drawn correctly. classify's 23503 branch means "unknown
// group", which is right for every caller except this one.
func DeleteGroup(ctx context.Context, e Execer, key string) (Group, error) {
	var g Group
	err := e.QueryRow(ctx,
		`DELETE FROM platform_tool_groups WHERE key = $1 RETURNING key, label, sort_order`, key).
		Scan(&g.Key, &g.Label, &g.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Group{}, ErrNoRow
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return Group{}, ErrGroupHasTools
		}
		return Group{}, classify(err)
	}
	return g, nil
}
