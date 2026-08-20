package repository_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// world is a migrated database plus the handful of inserts a queue test needs.
//
// Everything is written through explicit INSERTs against the REAL schema
// (testdb applies apps/web/db/migrations verbatim), so a fixture that violates
// a constraint fails here rather than agreeing with whatever the author
// believed the schema was. `crm_opp_product_required_when_qualified` is the
// one that bites: an opportunity at qualified/won/lost MUST carry a product,
// and a spec that forgets one gets a constraint error naming it.
type world struct {
	t    *testing.T
	pool *pgxpool.Pool
	ctx  context.Context
	// base is captured ONCE, so every relative timestamp in a test is measured
	// from the same instant. The queries compare against now(), which is later
	// than base by however long the fixture took — which is why boundary tests
	// below leave a minute of margin rather than a second.
	base time.Time
	orgs map[string]string
}

func newWorld(t *testing.T) *world {
	t.Helper()
	return &world{
		t:    t,
		pool: testdb.New(t),
		ctx:  context.Background(),
		base: time.Now().UTC(),
		orgs: map[string]string{},
	}
}

type contactSpec struct {
	primary bool
	// followers is nil for a contact with no recorded count — the state the
	// unset follower option selects on.
	followers *int
	// createdAt breaks the tie when neither contact is flagged primary. Zero
	// means "now", which is only safe when the org has one contact.
	createdAt time.Time
}

type orgSpec struct {
	name string
	// country is the DERIVED column, nil when no country could be derived —
	// 208 of 259 rows in production.
	country  *string
	contacts []contactSpec
}

func (w *world) org(spec orgSpec) string {
	w.t.Helper()
	var id string
	if err := w.pool.QueryRow(w.ctx,
		`INSERT INTO crm_organisations (name, country) VALUES ($1, $2) RETURNING id::text`,
		spec.name, spec.country,
	).Scan(&id); err != nil {
		w.t.Fatalf("seeding organisation %q: %v", spec.name, err)
	}
	w.orgs[spec.name] = id

	for i, c := range spec.contacts {
		createdAt := c.createdAt
		if createdAt.IsZero() {
			createdAt = w.base
		}
		if _, err := w.pool.Exec(w.ctx,
			`INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count, created_at)
			 VALUES ($1::uuid, $2, $3, $4, $5)`,
			id, spec.name+"-contact", c.primary, c.followers, createdAt,
		); err != nil {
			w.t.Fatalf("seeding contact %d of %q: %v", i, spec.name, err)
		}
	}
	return id
}

type oppSpec struct {
	// org is an organisation already seeded by w.org.
	org string
	// label is written to next_action_note and is how assertions name a row.
	// The opportunity has no title column, and borrowing a filter axis (owner,
	// product) for the purpose would make the filter tests assert on the thing
	// they are filtering by.
	label           string
	product         *string
	stage           domain.Stage
	owner           *string
	nextActionAt    *time.Time
	lastContactedAt *time.Time
	// createdAt matters only when lastContactedAt is nil: it is the other half
	// of the drifting queue's COALESCE.
	createdAt *time.Time
	starred   bool
}

func (w *world) opportunity(spec oppSpec) string {
	w.t.Helper()
	orgID, ok := w.orgs[spec.org]
	if !ok {
		w.t.Fatalf("opportunity %q names organisation %q, which was never seeded", spec.label, spec.org)
	}
	stage := spec.stage
	if stage == "" {
		stage = domain.StageNew
	}
	createdAt := w.base
	if spec.createdAt != nil {
		createdAt = *spec.createdAt
	}
	var id string
	if err := w.pool.QueryRow(w.ctx,
		`INSERT INTO crm_opportunities
		   (organisation_id, product, stage, owner, next_action_at, next_action_note,
		    last_contacted_at, is_starred, created_at)
		 VALUES ($1::uuid, $2, $3::crm_stage, $4, $5, $6, $7, $8, $9)
		 RETURNING id::text`,
		orgID, spec.product, string(stage), spec.owner, spec.nextActionAt, spec.label,
		spec.lastContactedAt, spec.starred, createdAt,
	).Scan(&id); err != nil {
		w.t.Fatalf("seeding opportunity %q: %v", spec.label, err)
	}
	return id
}

// ago and hence are offsets from the fixture's single captured instant.
func (w *world) ago(d time.Duration) *time.Time   { t := w.base.Add(-d); return &t }
func (w *world) hence(d time.Duration) *time.Time { t := w.base.Add(d); return &t }

const day = 24 * time.Hour

func labels(rows []domain.Opportunity) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		if r.NextActionNote == nil {
			out[i] = "<no label>"
			continue
		}
		out[i] = *r.NextActionNote
	}
	return out
}

// sortedLabels is labels() for an assertion whose subject is WHICH rows came
// back rather than in what order — rows sharing a sort timestamp come back in
// uuid order, which is stable but not predictable from the fixture.
func sortedLabels(rows []domain.Opportunity) []string {
	out := labels(rows)
	slices.Sort(out)
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func ptr[T any](v T) *T { return &v }
