package handler_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The module is exercised through its REAL router, its real verifier and a
// real database (§9). Only the token's SIGNATURE is faked, because that is the
// one part that must not be reimplemented for a test — everything else (the
// capability gate, the envelope, the SQL) is what these assertions are about.
//
// The capability-REFUSAL tests are not here. Task 6 registers the module and
// owns them, and duplicating them would put the same guarantee in two places
// where only one of them would be updated.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
)

// stubParser stands in for Zitadel's JWKS. It verifies nothing; the Verifier's
// own policy — audience, expiry, roles — still runs on what it returns.
type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Email:     "operator@tesserix.test",
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

// jwtShaped is three dot-separated segments, because the Verifier refuses an
// opaque token before it parses anything.
const jwtShaped = "header.payload.signature"

type api struct {
	handler http.Handler
	pool    *pgxpool.Pool
	t       *testing.T
	// base is captured ONCE, so every relative timestamp in a test is measured
	// from the same instant. The queries compare against now(), which is later
	// than base by however long the fixture took.
	base time.Time
	orgs map[string]string
}

func serve(t *testing.T) *api {
	t.Helper()
	pool := testdb.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("read", "crm")}, projectID)
	// Through RegisterModule, not by calling Routes directly: registering a
	// module is exactly where the "no verifier, no module" guard lives, and a
	// test that went around it would not be testing how the module is served.
	//
	// The module's own Register/Config file is Task 6's, so this composes what
	// that file will compose. When it lands, this becomes crm.Register.
	httpx.RegisterModule(mux, verifier, "crm", func(m *http.ServeMux) {
		handler.New(service.New(pool), log).Routes(m, verifier)
	})

	return &api{
		handler: httpx.WithMiddleware(mux),
		pool:    pool,
		t:       t,
		base:    time.Now().UTC(),
		orgs:    map[string]string{},
	}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) get(path string) response {
	a.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("GET %s: response is not JSON: %v (%s)", path, err, out.raw)
	}
	return out
}

// labels is the `next_action_note` of every row, which is how the fixtures
// name a row: an opportunity has no title column, and borrowing a filter axis
// (owner, product) for the purpose would make a filter test assert on the very
// thing it is filtering by.
func (r response) labels(t *testing.T) []string {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("status %d: %s", r.status, r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is missing or not an object: %s", r.raw)
	}
	rows, ok := data["opportunities"].([]any)
	if !ok {
		t.Fatalf("data.opportunities is missing or not an array: %s", r.raw)
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		note, _ := row.(map[string]any)["next_action_note"].(string)
		out = append(out, note)
	}
	return out
}

// sorted is labels() for an assertion whose subject is WHICH rows came back
// rather than in what order.
func (r response) sorted(t *testing.T) []string {
	t.Helper()
	out := r.labels(t)
	sort.Strings(out)
	return out
}

func (r response) meta(t *testing.T) map[string]any {
	t.Helper()
	m, ok := r.body["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta is missing or not an object: %s", r.raw)
	}
	return m
}

// ---- fixtures ------------------------------------------------------------
//
// Written through explicit INSERTs against the REAL schema, so a fixture that
// violates a constraint fails here rather than agreeing with whatever the
// author believed the schema was. `crm_opp_product_required_when_qualified` is
// the one that bites: an opportunity at qualified/won/lost MUST carry a
// product.

type contactSpec struct {
	primary bool
	// followers is nil for a contact with no recorded count — the state
	// followers_unset selects on.
	followers *int
}

type orgSpec struct {
	name string
	// country is the DERIVED column, nil when none could be derived.
	country  *string
	contacts []contactSpec
}

func (a *api) org(spec orgSpec) string {
	a.t.Helper()
	var id string
	if err := a.pool.QueryRow(context.Background(),
		`INSERT INTO crm_organisations (name, country) VALUES ($1, $2) RETURNING id::text`,
		spec.name, spec.country,
	).Scan(&id); err != nil {
		a.t.Fatalf("seeding organisation %q: %v", spec.name, err)
	}
	a.orgs[spec.name] = id

	for i, c := range spec.contacts {
		if _, err := a.pool.Exec(context.Background(),
			`INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count, created_at)
			 VALUES ($1::uuid, $2, $3, $4, $5)`,
			id, spec.name+"-contact", c.primary, c.followers, a.base,
		); err != nil {
			a.t.Fatalf("seeding contact %d of %q: %v", i, spec.name, err)
		}
	}
	return id
}

type oppSpec struct {
	org             string
	label           string
	product         *string
	stage           domain.Stage
	owner           *string
	nextActionAt    *time.Time
	lastContactedAt *time.Time
	createdAt       *time.Time
	starred         bool
}

func (a *api) opportunity(spec oppSpec) string {
	a.t.Helper()
	orgID, ok := a.orgs[spec.org]
	if !ok {
		a.t.Fatalf("opportunity %q names organisation %q, which was never seeded", spec.label, spec.org)
	}
	stage := spec.stage
	if stage == "" {
		stage = domain.StageNew
	}
	createdAt := a.base
	if spec.createdAt != nil {
		createdAt = *spec.createdAt
	}
	var id string
	if err := a.pool.QueryRow(context.Background(),
		`INSERT INTO crm_opportunities
		   (organisation_id, product, stage, owner, next_action_at, next_action_note,
		    last_contacted_at, is_starred, created_at)
		 VALUES ($1::uuid, $2, $3::crm_stage, $4, $5, $6, $7, $8, $9)
		 RETURNING id::text`,
		orgID, spec.product, string(stage), spec.owner, spec.nextActionAt, spec.label,
		spec.lastContactedAt, spec.starred, createdAt,
	).Scan(&id); err != nil {
		a.t.Fatalf("seeding opportunity %q: %v", spec.label, err)
	}
	return id
}

func (a *api) ago(d time.Duration) *time.Time { t := a.base.Add(-d); return &t }

const day = 24 * time.Hour

func ptr[T any](v T) *T { return &v }

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

// filterWorld seeds one row per interesting combination of the five axes, so a
// single fixture serves every filter test and each test's assertion is about
// the axis it names rather than about the fixture.
//
// Every row is DUE (next action in the past, non-terminal), so the due queue
// returns all of them unfiltered and a filter's effect is the whole of what
// each test observes.
func filterWorld(t *testing.T) *api {
	a := serve(t)

	a.org(orgSpec{name: "Acme", country: ptr("IN"), contacts: []contactSpec{{primary: true, followers: ptr(500)}}})
	a.org(orgSpec{name: "Borealis", country: ptr("GB"), contacts: []contactSpec{{primary: true, followers: ptr(5000)}}})
	a.org(orgSpec{name: "Cinder", country: nil, contacts: []contactSpec{{primary: true, followers: ptr(50000)}}})
	// No contact at all: it has no follower count to show, so it is what
	// followers_unset selects and no band can reach.
	a.org(orgSpec{name: "Dune", country: nil})

	a.opportunity(oppSpec{org: "Acme", label: "acme-mark8ly", product: ptr("mark8ly"),
		stage: domain.StageContacted, owner: ptr("Priya Raman"), nextActionAt: a.ago(day)})
	a.opportunity(oppSpec{org: "Borealis", label: "borealis-tesserix", product: ptr("tesserix"),
		stage: domain.StageQualified, owner: ptr("Sam Okafor"), nextActionAt: a.ago(2 * day)})
	a.opportunity(oppSpec{org: "Cinder", label: "cinder-unattributed", product: nil,
		stage: domain.StageNew, owner: ptr("priya raman"), nextActionAt: a.ago(3 * day)})
	a.opportunity(oppSpec{org: "Dune", label: "dune-unattributed", product: nil,
		stage: domain.StageNew, owner: nil, nextActionAt: a.ago(4 * day)})

	return a
}

// ---- the filter axes over the wire ---------------------------------------

func TestEachFilterAxisNarrowsTheQueueOverTheWire(t *testing.T) {
	a := filterWorld(t)

	if got := a.get("/v1/crm/queues/due").sorted(t); len(got) != 4 {
		t.Fatalf("the unfiltered queue = %v, want all four rows", got)
	}

	for _, c := range []struct {
		name  string
		query string
		want  []string
	}{
		{"product", "?product=mark8ly", []string{"acme-mark8ly"}},
		{"stage", "?stage=qualified", []string{"borealis-tesserix"}},
		// Case-insensitive SUBSTRING, matching the console: "raman" reaches
		// both "Priya Raman" and "priya raman".
		{"owner", "?owner=raman", []string{"acme-mark8ly", "cinder-unattributed"}},
		{"country", "?country=GB", []string{"borealis-tesserix"}},
		{"followers under1k", "?followers=under1k", []string{"acme-mark8ly"}},
		{"followers k1to10k", "?followers=k1to10k", []string{"borealis-tesserix"}},
		{"followers over10k", "?followers=over10k", []string{"cinder-unattributed"}},
		// Two axes at once: the conjunction narrows, it does not union.
		{"product and country", "?product=tesserix&country=GB", []string{"borealis-tesserix"}},
		{"product and country disagreeing", "?product=mark8ly&country=GB", []string{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := a.get("/v1/crm/queues/due" + c.query)
			if got.status != http.StatusOK {
				t.Fatalf("status %d: %s", got.status, got.raw)
			}
			if labels := got.sorted(t); !equal(labels, c.want) {
				t.Errorf("%s = %v, want %v", c.query, labels, c.want)
			}
		})
	}
}

// The band NAMES are byte-identical to FOLLOWER_BANDS' keys in
// apps/console/lib/db/crm-filters.ts. That is the whole of the console's
// translation problem: only ABSENCE needs mapping at cutover, and a band whose
// name differed here would be a filter the operator can select and this
// service rejects.
func TestTheFollowerBandNamesAreTheConsoles(t *testing.T) {
	a := filterWorld(t)

	for _, band := range []string{"under1k", "k1to10k", "over10k"} {
		if got := a.get("/v1/crm/queues/due?followers=" + band); got.status != http.StatusOK {
			t.Errorf("followers=%s = %d, want 200 — the name must be the console's: %s",
				band, got.status, got.raw)
		}
	}
	// And the console's SENTINEL is not on the wire. "__unknown__" is the
	// filter bar's vocabulary; absence is followers_unset=true.
	if got := a.get("/v1/crm/queues/due?followers=__unknown__"); got.status != http.StatusUnprocessableEntity {
		t.Errorf("followers=__unknown__ = %d, want 422 — the console's sentinel is not a band", got.status)
	}
}

// ---- absence is a sibling flag ------------------------------------------

func TestTheUnsetFlagSelectsRowsWithNoValueOnEachNullableAxis(t *testing.T) {
	a := filterWorld(t)

	for _, c := range []struct {
		name  string
		query string
		want  []string
	}{
		{"product_unset", "?product_unset=true", []string{"cinder-unattributed", "dune-unattributed"}},
		{"country_unset", "?country_unset=true", []string{"cinder-unattributed", "dune-unattributed"}},
		// Dune has no contact at all, so it has no follower count to show.
		// Bands ∪ unset covers every row, which is the defect this option
		// exists to fix.
		{"followers_unset", "?followers_unset=true", []string{"dune-unattributed"}},
		// false is not "unset"; it is no filter at all.
		{"product_unset=false", "?product_unset=false", []string{
			"acme-mark8ly", "borealis-tesserix", "cinder-unattributed", "dune-unattributed"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := a.get("/v1/crm/queues/due" + c.query)
			if got.status != http.StatusOK {
				t.Fatalf("status %d: %s", got.status, got.raw)
			}
			if labels := got.sorted(t); !equal(labels, c.want) {
				t.Errorf("%s = %v, want %v", c.query, labels, c.want)
			}
		})
	}
}

// The grammar is asymmetric on purpose: stage is NOT NULL and there is no
// "unassigned owner" concept, so neither has an _unset sibling. A caller that
// assumes the symmetry gets told, rather than getting an unfiltered queue.
func TestTheAxesWithoutAnUnsetSiblingSaySo(t *testing.T) {
	a := filterWorld(t)

	for _, query := range []string{"?stage_unset=true", "?owner_unset=true"} {
		got := a.get("/v1/crm/queues/due" + query)
		if got.status != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400 — the asymmetry is deliberate and must be visible", query, got.status)
		}
	}
}

// An empty value is NO FILTER, identical to omitting the parameter. It is what
// domain.Is("") collapses to and what the console's falsy check produces, and
// it is stated as contract rather than left to be discovered by whoever sends
// an empty string expecting "rows with no product".
func TestAnEmptyValueIsNoFilterRatherThanAbsence(t *testing.T) {
	a := filterWorld(t)

	all := a.get("/v1/crm/queues/due").sorted(t)
	for _, query := range []string{"?product=", "?country=", "?followers=", "?owner=", "?stage="} {
		if got := a.get("/v1/crm/queues/due" + query).sorted(t); !equal(got, all) {
			t.Errorf("%s = %v, want the whole queue %v — an empty value is no filter", query, got, all)
		}
	}
}

// "product=acme AND product is absent" is a contradiction. Refused rather than
// resolved by precedence, because either precedence rule answers a question
// the caller did not ask and reports success.
func TestAnAxisCannotBeBothAValueAndUnset(t *testing.T) {
	a := filterWorld(t)

	got := a.get("/v1/crm/queues/due?product=mark8ly&product_unset=true")
	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("product and product_unset together = %d, want 422: %s", got.status, got.raw)
	}
}

// Anything but "true"/"false" is rejected rather than read as false. A caller
// sending `product_unset=yes` and meaning it would otherwise get the whole
// queue, reported as a success.
func TestAnUnsetFlagThatIsNotTrueOrFalseIsRefused(t *testing.T) {
	a := filterWorld(t)

	for _, raw := range []string{"yes", "1", "TRUE", "t"} {
		if got := a.get("/v1/crm/queues/due?product_unset=" + raw); got.status != http.StatusUnprocessableEntity {
			t.Errorf("product_unset=%s = %d, want 422", raw, got.status)
		}
	}
}

func TestAValueOutsideAnAxisVocabularyIsRefusedRatherThanIgnored(t *testing.T) {
	a := filterWorld(t)

	for _, query := range []string{
		"?stage=archived",     // not a crm_stage
		"?stage=won",          // a stage, but never in a queue — still a valid filter value
		"?country=in",         // lower case; the derived column is upper
		"?country=India",      // not alpha-2
		"?followers=under10k", // not a band
	} {
		got := a.get("/v1/crm/queues/due" + query)
		switch query {
		case "?stage=won":
			// Legal, and answers an empty queue: terminal deals are excluded
			// by the queue's own predicate, not by the filter.
			if got.status != http.StatusOK {
				t.Errorf("%s = %d, want 200: %s", query, got.status, got.raw)
			}
		default:
			if got.status != http.StatusUnprocessableEntity {
				t.Errorf("%s = %d, want 422 — a filter that matched nothing silently is the failure this prevents",
					query, got.status)
			}
		}
	}
}

// ---- the cursor ----------------------------------------------------------

func TestAMalformedCursorIsRefusedRatherThanServedAsPageOne(t *testing.T) {
	a := filterWorld(t)

	for _, name := range []string{"cursor"} {
		for _, raw := range []string{
			"nonsense",   // not base64url
			"eyJ2IjoxfQ", // decodes, but has no direction and no key
			"eyJ2IjoxLCJkIjoiYWZ0ZXIiLCJrIjpbImhlbGxvIiwid29ybGQiXX0", // right shape, wrong CONTENT
		} {
			got := a.get("/v1/crm/queues/due?" + name + "=" + raw)
			if got.status != http.StatusBadRequest {
				t.Errorf("%s=%s = %d, want 400 — a bad link, not a flaky read: %s",
					name, raw, got.status, got.raw)
			}
		}
	}
}

func TestACursorWalksTheQueueWithoutRepeatingOrSkippingARow(t *testing.T) {
	a := filterWorld(t)

	var seen []string
	cursor := ""
	for page := 0; page < 5; page++ {
		path := "/v1/crm/queues/due?limit=1"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		got := a.get(path)
		seen = append(seen, got.labels(t)...)
		next, _ := got.meta(t)["next_cursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	// Most-overdue-first: the queue's own order, ascending on next_action_at.
	want := []string{"dune-unattributed", "cinder-unattributed", "borealis-tesserix", "acme-mark8ly"}
	if !equal(seen, want) {
		t.Errorf("the walk = %v, want %v", seen, want)
	}
}

// ---- limit ---------------------------------------------------------------

func TestLimitIsClampedUpAndTheAppliedValueIsEchoed(t *testing.T) {
	a := filterWorld(t)

	got := a.get("/v1/crm/queues/due?limit=5000")
	if got.status != http.StatusOK {
		t.Fatalf("status %d: %s", got.status, got.raw)
	}
	if limit := got.meta(t)["limit"]; limit != float64(handler.MaxLimit) {
		t.Errorf("meta.limit = %v, want %d — a short page must not be mistaken for the end of the queue",
			limit, handler.MaxLimit)
	}

	if def := a.get("/v1/crm/queues/due").meta(t)["limit"]; def != float64(handler.DefaultLimit) {
		t.Errorf("the default meta.limit = %v, want %d", def, handler.DefaultLimit)
	}
}

// Rejected rather than clamped up. Asking for zero rows is a bug in the caller
// — most likely an uninitialised variable — and silently serving 50 would hide
// it.
//
// The STATUS is 422, not 400, and that is deliberate parity with the tickets
// module's readLimit: the request is well-formed and the service understood it
// and declined. A client meeting 422 from one module and 400 from another for
// the same mistake would be the second vocabulary §7 refuses.
func TestALimitBelowOneIsRefused(t *testing.T) {
	a := filterWorld(t)

	for _, raw := range []string{"0", "-1"} {
		if got := a.get("/v1/crm/queues/due?limit=" + raw); got.status != http.StatusUnprocessableEntity {
			t.Errorf("limit=%s = %d, want 422", raw, got.status)
		}
	}
	if got := a.get("/v1/crm/queues/due?limit=many"); got.status != http.StatusUnprocessableEntity {
		t.Errorf("limit=many = %d, want 422", got.status)
	}
}

// ---- unknown parameters --------------------------------------------------

// The read-side equivalent of DisallowUnknownFields. A caller sending
// `?stge=new` would otherwise receive the WHOLE queue and a 200 — a filter
// that silently does nothing, which is the broader-result-set failure running
// through this whole module.
func TestAnUnknownQueryParameterIsRefused(t *testing.T) {
	a := filterWorld(t)

	got := a.get("/v1/crm/queues/due?stge=new")
	if got.status != http.StatusBadRequest {
		t.Fatalf("stge=new = %d, want 400: %s", got.status, got.raw)
	}
	// The message must name what was wrong and what would have been right: the
	// person reading it is looking at a URL that does not work.
	if !strings.Contains(got.raw, "stge") || !strings.Contains(got.raw, "stage") {
		t.Errorf("the message names neither the unknown parameter nor the accepted ones: %s", got.raw)
	}

	// stale_days belongs to the drifting queue alone, so it is unknown on due.
	if got := a.get("/v1/crm/queues/due?stale_days=30"); got.status != http.StatusBadRequest {
		t.Errorf("stale_days on the due queue = %d, want 400 — it measures nothing there", got.status)
	}
}

// ---- the empty queue -----------------------------------------------------

// The response this queue is MEANT to reach. An empty collection must
// serialise as [] rather than null, and both counts must be PRESENT as zero
// rather than dropped: §3's honest-totals rule is that a client cannot tell
// "nothing matches your filter" from "this endpoint does not report totals" if
// a genuine zero disappears.
func TestAnEmptyQueueRendersAnEmptyArrayWithItsCountsPresent(t *testing.T) {
	a := serve(t)
	a.org(orgSpec{name: "Acme", country: ptr("IN")})
	// Not due: its next action is in the future.
	a.opportunity(oppSpec{org: "Acme", label: "acme-scheduled", product: ptr("mark8ly"),
		nextActionAt: ptr(a.base.Add(7 * day))})

	got := a.get("/v1/crm/queues/due")
	if got.status != http.StatusOK {
		t.Fatalf("status %d: %s", got.status, got.raw)
	}
	if !strings.Contains(got.raw, `"opportunities":[]`) {
		t.Errorf("the empty queue does not serialise as []: %s", got.raw)
	}
	meta := got.meta(t)
	if total, ok := meta["total"]; !ok || total != float64(0) {
		t.Errorf("meta.total = %v (present: %t), want a present 0", meta["total"], ok)
	}
	if preceding, ok := meta["preceding_count"]; !ok || preceding != float64(0) {
		t.Errorf("meta.preceding_count = %v (present: %t), want a present 0", meta["preceding_count"], ok)
	}
	// No cursors: an empty page that offered one would promise a neighbour it
	// cannot name a row for.
	if _, ok := meta["next_cursor"]; ok {
		t.Errorf("an empty page carries a next_cursor: %s", got.raw)
	}
}

// ---- the drifting queue --------------------------------------------------

func TestTheDriftingQueueTakesItsStalenessWindowFromTheRequest(t *testing.T) {
	a := serve(t)
	a.org(orgSpec{name: "Acme", country: ptr("IN")})
	// Quiet for 20 days, nothing scheduled.
	a.opportunity(oppSpec{org: "Acme", label: "acme-quiet-20d", product: ptr("mark8ly"),
		lastContactedAt: a.ago(20 * day)})
	// Quiet for 3 days: inside the default window, outside a 1-day one.
	a.opportunity(oppSpec{org: "Acme", label: "acme-quiet-3d", product: ptr("mark8ly"),
		lastContactedAt: a.ago(3 * day)})

	if got := a.get("/v1/crm/queues/drifting").sorted(t); !equal(got, []string{"acme-quiet-20d"}) {
		t.Errorf("the default window (%d days) = %v, want only the 20-day row",
			handler.DefaultStaleDays, got)
	}
	if got := a.get("/v1/crm/queues/drifting?stale_days=1").sorted(t); !equal(got,
		[]string{"acme-quiet-20d", "acme-quiet-3d"}) {
		t.Errorf("stale_days=1 = %v, want both rows", got)
	}
	if got := a.get("/v1/crm/queues/drifting?stale_days=365").sorted(t); !equal(got, []string{}) {
		t.Errorf("stale_days=365 = %v, want nothing", got)
	}
}

// A negative window asks for rows quiet since the future, which is empty —
// and answering "nothing is drifting" to a caller bug is the silent success
// this module refuses.
func TestAnUnusableStalenessWindowIsRefused(t *testing.T) {
	a := serve(t)

	for _, raw := range []string{"-1", "fortnight", "99999"} {
		if got := a.get("/v1/crm/queues/drifting?stale_days=" + raw); got.status != http.StatusUnprocessableEntity {
			t.Errorf("stale_days=%s = %d, want 422", raw, got.status)
		}
	}
	// Zero is legal: the whole open backlog rather than the drifting part.
	if got := a.get("/v1/crm/queues/drifting?stale_days=0"); got.status != http.StatusOK {
		t.Errorf("stale_days=0 = %d, want 200 — it is a coherent question", got.status)
	}
}

// The filters apply to both queues, from one parser. A queue that read its
// filters differently would be a second grammar.
func TestTheDriftingQueueTakesTheSameFilterGrammar(t *testing.T) {
	a := serve(t)
	a.org(orgSpec{name: "Acme", country: ptr("IN"), contacts: []contactSpec{{primary: true, followers: ptr(500)}}})
	a.org(orgSpec{name: "Cinder", country: nil})
	a.opportunity(oppSpec{org: "Acme", label: "acme-quiet", product: ptr("mark8ly"),
		owner: ptr("Priya Raman"), lastContactedAt: a.ago(30 * day)})
	a.opportunity(oppSpec{org: "Cinder", label: "cinder-quiet", product: nil,
		lastContactedAt: a.ago(30 * day)})

	for _, c := range []struct {
		query string
		want  []string
	}{
		{"?product=mark8ly", []string{"acme-quiet"}},
		{"?product_unset=true", []string{"cinder-quiet"}},
		{"?country_unset=true", []string{"cinder-quiet"}},
		{"?followers=under1k", []string{"acme-quiet"}},
		{"?owner=priya", []string{"acme-quiet"}},
	} {
		if got := a.get("/v1/crm/queues/drifting" + c.query).sorted(t); !equal(got, c.want) {
			t.Errorf("drifting%s = %v, want %v", c.query, got, c.want)
		}
	}
}

// ---- timestamps ----------------------------------------------------------

// The golden files mask a timestamp's VALUE, which also masks its OFFSET — so
// they would not catch the day the wire carried +10:00 on a laptop and Z in a
// container. This does.
func TestWireTimestampsAreUTCWhereverTheProcessRuns(t *testing.T) {
	a := filterWorld(t)

	raw := a.get("/v1/crm/queues/due").raw
	for _, field := range []string{"next_action_at", "quiet_since"} {
		marker := `"` + field + `":"`
		idx := strings.Index(raw, marker)
		if idx < 0 {
			t.Fatalf("%s is missing from the response: %s", field, raw)
		}
		rest := raw[idx+len(marker):]
		value := rest[:strings.Index(rest, `"`)]
		if !strings.HasSuffix(value, "Z") {
			t.Errorf("%s = %q, want a UTC instant ending in Z — the bytes of this contract "+
				"must not depend on where the process runs", field, value)
		}
	}
}
