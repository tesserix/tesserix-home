// Package repository holds the tickets module's SQL.
//
// Under modules/tickets/internal/, so only code rooted at modules/tickets/ can
// import it — the compiler enforces that, not a convention.
//
// # No ORM, and no query builder
//
// The kernel's database package records the general reason. The specific one
// here is the listing: it pages by keyset over a four-component sort, two
// components of which are derived. That is a query to write once and read
// carefully, not one to assemble.
package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/paging"
)

// ErrNotFound is returned for a ticket that does not exist. A sentinel because
// the handler turns it into a 404 and everything else into a 500, and that is
// a decision it must not make by inspecting an error string.
var ErrNotFound = errors.New("ticket not found")

// Querier is the subset of pgx the reads need. Satisfied by both a pool and a
// transaction, so a read can join a write's transaction when it must — the
// status endpoint re-reads the ticket it just updated, inside the same
// transaction, so the response cannot describe a state that was rolled back.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// The projection every ticket read shares, in two forms.
//
// `columns` casts the two uuid columns to text, because every consumer of this
// API treats them as opaque strings — the console's parser does
// `String(t.tenant_id ?? …)` and never parses one. Casting in SQL rather than
// in Go keeps the driver from choosing a representation.
//
// `bareColumns` does not cast, and the difference is not cosmetic. The listing
// selects these into a CTE and then applies the keyset predicate to it, and
// the predicate compares `id` against a `::uuid` parameter. With the cast
// applied inside the CTE, `id` arrives at the predicate as text and Postgres
// refuses with "operator does not exist: text < uuid" — so the CTE carries the
// real column types and the cast happens once, in the outer projection.
const (
	columns = `id::text, product_id, tenant_id::text, ticket_number, subject,
	description, status, priority, submitted_by_name, submitted_by_email,
	resolved_at, created_at, updated_at`

	bareColumns = `id, product_id, tenant_id, ticket_number, subject,
	description, status, priority, submitted_by_name, submitted_by_email,
	resolved_at, created_at, updated_at`
)

// sortColumns are the two derived components of the queue's order.
//
// They reproduce listPlatformTickets' ORDER BY: live tickets before finished
// ones, then most urgent first. Computed in a CTE rather than repeated in the
// ORDER BY and the keyset predicate, because the two must agree exactly and
// two copies of a CASE expression is how they stop agreeing.
const sortColumns = `
	CASE WHEN status IN ('open','in_progress') THEN 0 ELSE 1 END AS sort_bucket,
	CASE priority
		WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
		WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4
	END AS sort_rank`

// sortShape is this listing's key, component by component: the two derived
// integers, then updated_at, then id.
//
// Passed to paging.Decode, which checks both the COUNT and the CONTENT — so a
// cursor minted by a different listing is rejected rather than bound
// positionally against the wrong columns, and a well-formed cursor carrying
// nonsense in the right number of slots is a 400 rather than a ::timestamptz
// cast error surfacing as a 500.
var sortShape = paging.Shape{paging.Integer, paging.Integer, paging.Timestamp, paging.UUID}

// The keyset predicate and the ORDER BY, written as one direction.
//
// # Why the two derived components are negated
//
// The queue's display order is bucket ASC, rank ASC, updated_at DESC, id DESC
// — mixed directions. A row-value comparison, which is what makes a keyset
// predicate correct over a composite sort, compares the whole tuple in ONE
// direction; there is no per-component direction in `(a,b) < (c,d)`.
//
// Negating the two ascending integer components turns the sort into four
// descending components without changing a single row's position: bucket ASC
// is exactly (-bucket) DESC. The tuple is then uniformly descending and
// `(-bucket, -rank, updated_at, id) < (…)` means precisely "sorts after this
// row" in display order.
//
// The alternative — a chain of ORs, one per prefix of the sort key — is what
// a query builder would generate, is quadratic in the number of components,
// and cannot use an index the way a row comparison can.
const (
	forwardPredicate  = `(-sort_bucket, -sort_rank, updated_at, id) < (-$%d::int, -$%d::int, $%d::timestamptz, $%d::uuid)`
	backwardPredicate = `(-sort_bucket, -sort_rank, updated_at, id) > (-$%d::int, -$%d::int, $%d::timestamptz, $%d::uuid)`
	forwardOrder      = `ORDER BY (-sort_bucket) DESC, (-sort_rank) DESC, updated_at DESC, id DESC`
	backwardOrder     = `ORDER BY (-sort_bucket) ASC, (-sort_rank) ASC, updated_at ASC, id ASC`
)

// Filter narrows the queue. Every field is optional; an empty value means no
// filter on that column.
//
// Applied in SQL, ahead of ORDER BY and LIMIT. Filtering a fetched page in Go
// would answer "rows matching the filter among the first N overall", silently
// dropping a match ranked below the cut-off — the mistake the console's own
// comment on fetchTickets warns about.
type Filter struct {
	Status   string
	Priority string
	Product  string
	Tenant   string
}

// Page is one page of the queue plus the counts a caller needs to describe it
// honestly.
//
// The counts and the cursors are the kernel's own types, embedded rather than
// redeclared, so the fields a caller reads (Total, Preceding, NextCursor,
// PreviousCursor) are paging's and cannot drift from what paging.Resolve
// produced. Only the rows are named for the domain, which is what §2 asks of a
// resource: `page.Tickets` at a call site, not `page.Rows`.
type Page struct {
	Tickets []domain.Ticket
	paging.Counts
	paging.Cursors
}

// List reads one page of the queue.
//
// The count and the rows are two queries over two disjoint parameter lists,
// run sequentially rather than concurrently — paging.Counts carries the
// reasoning, since it now owns the pair.
func List(ctx context.Context, db Querier, filter Filter, limit int, rawCursor string) (Page, error) {
	var cursor *paging.Cursor
	if rawCursor != "" {
		decoded, err := paging.Decode(rawCursor, sortShape)
		if err != nil {
			// Before either query runs, so a bad cursor costs no round trip.
			return Page{}, err
		}
		cursor = &decoded
	}
	backwards := cursor != nil && cursor.Direction == paging.Before

	where, args := filterClauses(filter)
	countArgs := append([]any(nil), args...)

	// Rows ahead of this page, in the listing's own order. Aggregated into the
	// count query rather than asked for separately: it is the same predicate
	// over the same rows.
	//
	// Forward, the cursor is the last row of the previous page and the page
	// predicate below excludes it, so it counts as preceding (>=). Backward,
	// the cursor is the first row of the page being left: it sorts after this
	// page, so it is excluded (>), and the count then covers this page plus
	// everything ahead of it — the page's own length is subtracted at the end.
	precedingSelect := "0"
	if cursor != nil {
		comparison := ">="
		if backwards {
			comparison = ">"
		}
		countArgs = append(countArgs, cursor.Key[0], cursor.Key[1], cursor.Key[2], cursor.Key[3])
		base := len(countArgs) - 3
		precedingSelect = fmt.Sprintf(
			`count(*) FILTER (WHERE (-sort_bucket, -sort_rank, updated_at, id) %s (-$%d::int, -$%d::int, $%d::timestamptz, $%d::uuid))`,
			comparison, base, base+1, base+2, base+3)
	}

	var total int64
	var preceding int
	countSQL := fmt.Sprintf(
		`WITH ranked AS (SELECT id, status, priority, updated_at, %s FROM platform_tickets %s)
		 SELECT count(*), %s FROM ranked`,
		sortColumns, where, precedingSelect)
	if err := db.QueryRow(ctx, countSQL, countArgs...).Scan(&total, &preceding); err != nil {
		return Page{}, fmt.Errorf("counting tickets: %w", err)
	}

	pageClauses := where
	pageArgs := append([]any(nil), args...)
	if cursor != nil {
		pageArgs = append(pageArgs, cursor.Key[0], cursor.Key[1], cursor.Key[2], cursor.Key[3])
		base := len(pageArgs) - 3
		predicate := forwardPredicate
		if backwards {
			predicate = backwardPredicate
		}
		pageClauses = andClause(pageClauses, fmt.Sprintf(predicate, base, base+1, base+2, base+3))
	}
	order := forwardOrder
	if backwards {
		// Flipped with the comparison. Without this the LIMIT would keep the
		// rows FURTHEST from the anchor — the top of the whole queue, not the
		// page immediately before this cursor.
		order = backwardOrder
	}
	// limit + 1: the extra row is the proof another page exists. Comparing
	// against the total instead would be wrong under a concurrent insert, and
	// would still need this query to have read one row further.
	pageArgs = append(pageArgs, limit+1)

	pageSQL := fmt.Sprintf(
		`WITH ranked AS (SELECT %s, %s FROM platform_tickets %s)
		 SELECT %s FROM ranked %s %s LIMIT $%d`,
		bareColumns, sortColumns, where,
		columns, pageClauses, order, len(pageArgs))

	rows, err := db.Query(ctx, pageSQL, pageArgs...)
	if err != nil {
		return Page{}, fmt.Errorf("listing tickets: %w", err)
	}
	fetched, err := scanTickets(rows)
	if err != nil {
		return Page{}, err
	}

	// The trimming, the backward adjustment of Preceding, and both cursors are
	// the kernel's: paging.Resolve owns the forward/backward asymmetry so that
	// the next module does not re-derive it. This module supplies only what
	// the kernel cannot know — the counts its own SQL produced, and the key
	// its own ORDER BY sorts on.
	resolved, err := paging.Resolve(fetched, limit, cursor,
		&paging.Counts{Total: total, Preceding: preceding}, cursorKey)
	if err != nil {
		return Page{}, err
	}
	// Non-nil because counts were passed above; this listing always reports
	// them. A listing that did not would leave the embedded Counts zero, and
	// its handler would leave httpx.Meta's pointers nil.
	return Page{Tickets: resolved.Rows, Counts: *resolved.Counts, Cursors: resolved.Cursors}, nil
}

// cursorKey renders the anchor for one row: this listing's four ORDER BY
// components, in declaration order, as text.
//
// The two derived components are recomputed in Go from the row's own status
// and priority rather than selected back out of the CTE. They are pure
// functions of two columns the row already carries, so a second copy in the
// projection would be a value that could disagree with the ORDER BY that
// produced the row — and the disagreement would show as a page boundary that
// skips or repeats a ticket.
func cursorKey(t domain.Ticket) []string {
	return []string{
		fmt.Sprintf("%d", sortBucket(t.Status)),
		fmt.Sprintf("%d", sortRank(t.Priority)),
		t.UpdatedAt.UTC().Format(time.RFC3339Nano),
		t.ID,
	}
}

// sortBucket and sortRank mirror sortColumns. They are the one place this
// module says the same thing in both Go and SQL; the listing tests page
// through a fixture that exercises every bucket and rank, which is what makes
// a drift between them fail rather than reorder the queue quietly.
func sortBucket(status domain.Status) int {
	if status == domain.StatusOpen || status == domain.StatusInProgress {
		return 0
	}
	return 1
}

func sortRank(priority domain.Priority) int {
	switch priority {
	case domain.PriorityUrgent:
		return 0
	case domain.PriorityHigh:
		return 1
	case domain.PriorityMedium:
		return 2
	case domain.PriorityLow:
		return 3
	default:
		return 4
	}
}

func filterClauses(filter Filter) (string, []any) {
	var clauses []string
	var args []any
	add := func(sql string, value string) {
		if value == "" {
			return
		}
		args = append(args, value)
		clauses = append(clauses, fmt.Sprintf(sql, len(args)))
	}
	add("status = $%d", filter.Status)
	add("priority = $%d", filter.Priority)
	add("product_id = $%d", filter.Product)
	add("tenant_id = $%d::uuid", filter.Tenant)
	if len(clauses) == 0 {
		return "", nil
	}
	return "WHERE " + strings.Join(clauses, " AND "), args
}

func andClause(existing, clause string) string {
	if existing == "" {
		return "WHERE " + clause
	}
	return existing + " AND " + clause
}

func scanTickets(rows pgx.Rows) ([]domain.Ticket, error) {
	defer rows.Close()
	tickets := make([]domain.Ticket, 0, 16)
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, err
		}
		tickets = append(tickets, t)
	}
	if err := rows.Err(); err != nil {
		// Checked rather than assumed: a Next() loop that ends early because
		// the connection dropped looks exactly like one that ran out of rows,
		// and without this the caller would serve a short page as a complete
		// one.
		return nil, fmt.Errorf("reading tickets: %w", err)
	}
	return tickets, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanTicket(row scanner) (domain.Ticket, error) {
	var t domain.Ticket
	var status, priority string
	err := row.Scan(
		&t.ID, &t.ProductID, &t.TenantID, &t.TicketNumber, &t.Subject,
		&t.Description, &status, &priority, &t.SubmittedByName, &t.SubmittedByEmail,
		&t.ResolvedAt, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return domain.Ticket{}, err
	}
	// Narrowed on the way OUT of the database as well as on the way in. The
	// CHECK constraints make this unreachable, which is the point: if it ever
	// fires, a constraint was dropped and the module should say so rather than
	// carry an unknown value into a response the console parses strictly.
	if t.Status, err = domain.ParseStatus(status); err != nil {
		return domain.Ticket{}, fmt.Errorf("ticket %s: %w", t.ID, err)
	}
	if t.Priority, err = domain.ParsePriority(priority); err != nil {
		return domain.Ticket{}, fmt.Errorf("ticket %s: %w", t.ID, err)
	}
	return t, nil
}

// Get reads one ticket.
func Get(ctx context.Context, db Querier, id string) (domain.Ticket, error) {
	row := db.QueryRow(ctx,
		`SELECT `+columns+` FROM platform_tickets WHERE id = $1::uuid`, id)
	t, err := scanTicket(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Ticket{}, ErrNotFound
	}
	if err != nil {
		return domain.Ticket{}, fmt.Errorf("reading ticket %s: %w", id, err)
	}
	return t, nil
}

// Replies reads a ticket's thread, oldest first.
//
// Oldest first because it is a conversation. The listing is newest-first
// because it is a queue; the two orders are different questions and neither
// should be inferred from the other.
func Replies(ctx context.Context, db Querier, ticketID string) ([]domain.Reply, error) {
	rows, err := db.Query(ctx,
		`SELECT id::text, ticket_id::text, author_type, author_name,
		        COALESCE(author_email, ''), content, created_at
		   FROM platform_ticket_replies
		  WHERE ticket_id = $1::uuid
		  ORDER BY created_at ASC, id ASC`, ticketID)
	if err != nil {
		return nil, fmt.Errorf("reading replies for %s: %w", ticketID, err)
	}
	defer rows.Close()

	replies := make([]domain.Reply, 0, 8)
	for rows.Next() {
		var r domain.Reply
		var authorType string
		if err := rows.Scan(&r.ID, &r.TicketID, &authorType, &r.AuthorName,
			&r.AuthorEmail, &r.Content, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("reading replies for %s: %w", ticketID, err)
		}
		// author_type decides whether a message renders as the merchant's or
		// the operator's. The console's parser REJECTS an unknown value rather
		// than rendering it, and so does this: a misattributed message is
		// worse than a failed read.
		switch domain.AuthorType(authorType) {
		case domain.AuthorMerchant, domain.AuthorOperator:
			r.AuthorType = domain.AuthorType(authorType)
		default:
			return nil, fmt.Errorf("reply %s carries an unknown author_type %q", r.ID, authorType)
		}
		replies = append(replies, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading replies for %s: %w", ticketID, err)
	}
	return replies, nil
}

// Summary reads the standing count of the queue.
//
// Unfiltered, deliberately. It is a property of the QUEUE, not of a view onto
// it: recomputing it per filter would make the headline numbers move as an
// operator narrows the list, and #269's own contract test asserts the summary
// does not change when a filter does.
//
// One query with FILTER clauses rather than four counts. On a shared
// db-f1-micro the difference between one sequential scan and four is the whole
// cost of this endpoint.
// product confines the counts to one product. EMPTY MEANS THE ESTATE — an
// operator's summary, which is what this counted before #152 and must keep
// counting. A scoped caller passes its own product and is counted only its own
// rows; without this the summary would report the estate's open count to a
// caller that cannot read a single one of those tickets.
func Summary(ctx context.Context, db Querier, product string) (domain.Summary, error) {
	var s domain.Summary
	err := db.QueryRow(ctx,
		`SELECT
		   count(*) FILTER (WHERE status = 'open'),
		   count(*) FILTER (WHERE status = 'in_progress'),
		   count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= now() - interval '7 days'),
		   count(*) FILTER (WHERE status IN ('open','in_progress') AND priority = 'urgent')
		 FROM platform_tickets
		 WHERE ($1::text = '' OR product_id = $1::text)`,
		product,
	).Scan(&s.Open, &s.InProgress, &s.ResolvedThisWeek, &s.UrgentOpen)
	if err != nil {
		return domain.Summary{}, fmt.Errorf("reading the ticket summary: %w", err)
	}
	return s, nil
}

// InsertReply appends one message to a ticket's thread.
//
// Takes a Querier so it can run on the caller's transaction, which it always
// does: a reply, its optional status transition and its audit row must land
// together or not at all.
func InsertReply(ctx context.Context, db Querier, r domain.Reply) (domain.Reply, error) {
	var out domain.Reply
	var authorType string
	err := db.QueryRow(ctx,
		`INSERT INTO platform_ticket_replies
		   (ticket_id, author_type, author_name, author_email, author_user_id, content)
		 VALUES ($1::uuid, $2, $3, $4, $5, $6)
		 RETURNING id::text, ticket_id::text, author_type, author_name,
		           COALESCE(author_email, ''), content, created_at`,
		r.TicketID, string(r.AuthorType), r.AuthorName, nullIfEmpty(r.AuthorEmail),
		nullIfEmpty(r.AuthorUserID), r.Content,
	).Scan(&out.ID, &out.TicketID, &authorType, &out.AuthorName,
		&out.AuthorEmail, &out.Content, &out.CreatedAt)
	if err != nil {
		return domain.Reply{}, fmt.Errorf("inserting a reply on %s: %w", r.TicketID, err)
	}
	out.AuthorType = domain.AuthorType(authorType)
	return out, nil
}

// SetStatus applies a transition and returns the ticket as it now stands.
//
// resolved_at is stamped only when it is NULL — the ticket is being resolved
// for the FIRST time. Expressed in SQL rather than by reading the row and
// deciding in Go, so a concurrent transition cannot land between the read and
// the write and reset a resolution time.
func SetStatus(ctx context.Context, db Querier, id string, status domain.Status) (domain.Ticket, error) {
	// $2 is cast explicitly at every use. Without it Postgres tries to deduce
	// one type from two contexts — a varchar comparison in SET and an untyped
	// literal comparison in the CASE — and refuses with "inconsistent types
	// deduced for parameter $2".
	row := db.QueryRow(ctx,
		`UPDATE platform_tickets
		    SET status = $2::text,
		        resolved_at = CASE
		          WHEN $2::text = 'resolved' AND resolved_at IS NULL THEN now()
		          ELSE resolved_at
		        END
		  WHERE id = $1::uuid
		 RETURNING `+columns, id, string(status))
	t, err := scanTicket(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Ticket{}, ErrNotFound
	}
	if err != nil {
		return domain.Ticket{}, fmt.Errorf("updating ticket %s: %w", id, err)
	}
	return t, nil
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// NewTicket is a ticket being filed.
//
// ProductID is NOT taken from the caller's request — it comes from the scope
// the registry resolved. A product filing against another product's queue is
// the leak #152 exists to close, and a field the caller could set would be
// exactly that.
type NewTicket struct {
	ProductID         string
	TenantID          string
	Subject           string
	Description       string
	Priority          domain.Priority
	SubmittedByName   string
	SubmittedByEmail  string
	SubmittedByUserID string
}

// Insert files a ticket and returns it as stored.
//
// # The ticket number
//
// Allocated from `platform_tickets_seq` (migration 0002) and rendered by
// domain.TicketNumber, which carries the per-product prefix table. The
// sequence is shared across products deliberately: it is what apps/web uses,
// so numbers stay unique estate-wide and a merchant quoting "M8-0042" names
// one ticket.
//
// nextval is NOT transactional — a rolled-back insert still consumes the
// number, leaving a gap. That is true of apps/web today and is the right
// trade: the alternative is a lock that serialises every filing to make a
// counter look tidy.
//
// # Takes a Querier
//
// So it runs on the caller's transaction, which it always does: the ticket and
// its audit row must land together or not at all.
func Insert(ctx context.Context, db Querier, t NewTicket) (domain.Ticket, error) {
	var n int64
	if err := db.QueryRow(ctx, `SELECT nextval('platform_tickets_seq')`).Scan(&n); err != nil {
		return domain.Ticket{}, fmt.Errorf("allocating a ticket number: %w", err)
	}

	priority := t.Priority
	if priority == "" {
		// The column's own default, stated here because the insert names the
		// column and so bypasses it.
		priority = domain.PriorityMedium
	}

	row := db.QueryRow(ctx,
		`INSERT INTO platform_tickets
		   (product_id, tenant_id, ticket_number, subject, description,
		    priority, submitted_by_name, submitted_by_email, submitted_by_user_id)
		 VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING `+columns,
		t.ProductID, t.TenantID, domain.TicketNumber(t.ProductID, n),
		t.Subject, t.Description, string(priority),
		t.SubmittedByName, t.SubmittedByEmail,
		// submitted_by_user_id is TEXT (migration 0003) so a foreign
		// identifier — mark8ly sends Firebase UIDs — stores without a uuid
		// cast. NULL rather than a blank string when absent.
		nullIfEmpty(t.SubmittedByUserID))

	created, err := scanTicket(row)
	if err != nil {
		return domain.Ticket{}, fmt.Errorf("filing a ticket: %w", err)
	}
	return created, nil
}
