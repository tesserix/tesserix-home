package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/write"
)

// Service is the CRM queues module's operations over a pool.
//
// Thin, deliberately: both reads are one repository call and one mapping. It
// exists rather than letting the handler call the repository directly for two
// reasons — the wire types live here and the handler should not learn the
// domain's shape, and Task 5's write needs a transaction script to live
// somewhere that is not an HTTP handler.
type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// Due reads one page of the opportunities whose next action has arrived.
//
// The repository.Page is returned ALONGSIDE the payload rather than folded
// into it, because its counts and cursors belong in the envelope's `meta`, not
// in `data`. A payload carrying its own pagination would be a second place for
// a client to look for it.
func (s *Service) Due(ctx context.Context, filter domain.Filter, limit int, cursor string) (QueuePayload, repository.Page, error) {
	page, err := repository.Due(ctx, s.pool, filter, limit, cursor)
	if err != nil {
		return QueuePayload{}, repository.Page{}, err
	}
	return QueuePayload{Opportunities: toOpportunities(page.Opportunities)}, page, nil
}

// Drifting reads one page of the opportunities that have gone quiet with
// nothing scheduled.
func (s *Service) Drifting(ctx context.Context, filter domain.Filter, staleDays, limit int, cursor string) (QueuePayload, repository.Page, error) {
	page, err := repository.Drifting(ctx, s.pool, filter, staleDays, limit, cursor)
	if err != nil {
		return QueuePayload{}, repository.Page{}, err
	}
	return QueuePayload{Opportunities: toOpportunities(page.Opportunities)}, page, nil
}

// ---- writes -------------------------------------------------------------
//
// The module's one write. It goes through write.Perform, which binds it to its
// audit row and its idempotency record in ONE transaction — the same kernel
// the tickets module uses, and this is its first Go caller outside that
// module. What is left here is the domain: what to do, what to answer with,
// and what to call the action in the trail.

// ErrRefused means the request was understood and the domain declined it.
//
// Distinct from a malformed request and from a missing opportunity, because
// the three are three different answers: 422, 400 and 404. Collapsing them
// would make "you asked for something impossible" indistinguishable from "you
// asked wrongly", and only one of those is worth a client retrying
// differently. The tickets module draws the same three lines.
var ErrRefused = errors.New("the request was refused")

// Actor is the principal performing a write, reduced to what an audit row
// needs.
//
// The same shape as the tickets module's Actor, and for the same reason: a
// subject is the only identity either module has a reader for. Nothing this
// module writes is shown to a merchant, and the one thing the tickets module
// does show a merchant is signed by the platform rather than by a person
// (tickets/internal/service/service.go, displayName).
type Actor struct {
	// Subject is the Zitadel `sub` — the audit trail's actor and the scope of
	// an idempotency key.
	//
	// The only identity this module carries. An email was held here too until
	// it turned out to be writing the wrong identifier into the wrong table;
	// auditActor below is the whole story.
	Subject string
}

// auditActor is what lands in console_audit_log.actor.
//
// The SUBJECT, always. That column holds subjects and nothing else, which is
// documented and enforced on the console side: apps/console/lib/crm-write.ts
// exists because a second CRM surface hand-rolled its own write and "audited
// under `actor.email` while this wrapper always uses `actor.sub` (the
// column's documented contract)", leaving console_audit_log.actor holding two
// identity shapes depending on which surface produced the row. That is the
// defect the wrapper was lifted out to make structurally impossible, and this
// module writing an email would reintroduce it from Go.
//
// This returned the email where there was one until #450, and its comment
// justified that by claiming the console's existing CRM rows in this table
// carry `actor.email` and that this write appends to the same trail. Both
// halves were wrong, and they were wrong by conflating two tables:
//
//   - console_audit_log.actor is the audit trail. It had NO rows at all when
//     that comment was written, so there was no established email shape here
//     to be consistent with; the first two rows ever written to it are
//     subjects.
//   - crm_activities.actor is the CRM timeline the merchant-facing UI
//     renders. THAT is the table whose rows carry an email, it is written by
//     the console rather than by this module, and its contract is its own.
//
// So there was never one trail with a changing identifier — there are two
// tables with two contracts, and this one wants the subject. Nothing here
// widened it accidentally either: the email was empty for every operator
// until #450 began resolving it from userinfo, so this returned the subject
// in practice and matched the contract by accident. #450 would have made it
// start writing emails for real. That resolver has since been removed —
// auth.Principal carries no email at all now — but this is the wrapper that
// makes the contract hold on purpose rather than by luck.
func (a Actor) auditActor() string {
	return a.Subject
}

// SetNextAction schedules — or clears — an opportunity's next action.
//
// The Go rewrite of setNextAction (apps/console/lib/db/crm-repo.ts:730) and of
// the scheduleNextAction server action that audits it. Read
// repository.ErrProductRequired before touching the SQL: this write runs
// against a table with a NOT VALID CHECK that fires on rows it does not touch.
func (s *Service) SetNextAction(ctx context.Context, actor Actor, opportunityID string,
	action domain.NextAction, key *idempotency.Key,
) (write.Result, error) {
	// Normalised then validated, in that order: a note of spaces is not an
	// over-long note, and refusing it for its length would name the wrong
	// problem.
	action = action.Normalise()
	if err := action.Validate(); err != nil {
		return write.Result{}, fmt.Errorf("%w: %s", ErrRefused, err)
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		updated, err := repository.SetNextAction(ctx, tx, opportunityID, action)
		if err != nil {
			if errors.Is(err, repository.ErrProductRequired) {
				// A refusal, not a failure. The row is real and the request
				// was well-formed; the deal is missing a product it has
				// needed since it was migrated, and the operator can supply
				// one. 422 with that message beats a 500 carrying a Postgres
				// constraint name.
				return nil, audit.Entry{}, 0, fmt.Errorf("%w: %s", ErrRefused, err)
			}
			return nil, audit.Entry{}, 0, err
		}

		// Counts, never content. The note is the operator's own text and
		// already lives one table away; audit.Write REFUSES a key that is not
		// an identifier rather than stripping it, so a summariser that tried
		// to carry the note here would fail the write instead of quietly
		// producing a wider copy of the data.
		//
		// Clearing is counted as {scheduled: 0} rather than given its own
		// action. It is the same verb with the opposite argument — the console
		// spells both `crm.next_action.set` through one call — and an audit
		// reader asking "what happened to this deal's calendar" wants one
		// action to filter on, with the count saying which way it went.
		//
		// The ACTION matches the console. The COUNT does not, and the
		// divergence is deliberate: the console records {scheduled: 1} for a
		// CLEAR as well — a constant, not a count
		// (crm/[organisation]/actions.ts:152) — so once both writers
		// are appending to console_audit_log, anything aggregating `scheduled`
		// over that table is summing two meanings depending on which one
		// produced the row. The reading here is the honest one — a clear
		// scheduled nothing — so the console is arguably the side to change,
		// and until it does, a query over this column has to discriminate on
		// the writer rather than trust the sum.
		scheduled := 0
		if action.Scheduled() {
			scheduled = 1
		}

		return NextActionPayload{Opportunity: toOpportunity(updated)}, audit.Entry{
			Actor: actor.auditActor(),
			// Byte-identical to the console's action for this write
			// (crm/[organisation]/actions.ts:139). The two writers append to
			// ONE table, and a retention or alerting rule discriminates on
			// this column.
			Action:  "crm.next_action.set",
			Target:  opportunityID,
			Summary: map[string]int{"scheduled": scheduled},
		}, http.StatusOK, nil
	})
}
