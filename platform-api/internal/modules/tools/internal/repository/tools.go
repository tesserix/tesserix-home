// Package repository is the tools module's SQL, and the only place it lives.
//
// Under modules/tools/internal/, so only code rooted at modules/tools/ can
// import it.
package repository

import (
	"context"

	"github.com/jackc/pgx/v5"
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
