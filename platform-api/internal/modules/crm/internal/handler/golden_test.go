package handler_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
)

// Golden responses: the module's actual output, committed.
//
// # What they are for
//
// The console's CRM queue screen migrates onto this module, and its parsers
// cannot run against a Go process in CI — but they can run against its
// RECORDED output, and this is that output, produced by the real router, over
// a real database, through the real envelope.
//
// # Why committed rather than generated on demand
//
// A generated fixture proves the generator agrees with itself. A committed one
// makes a contract change VISIBLE IN A DIFF, which is the whole point for a
// contract products pin to. Regenerate deliberately:
//
//	go test ./internal/modules/crm/... -update-golden
//
// and read the diff before committing it. A golden file that changed without
// anybody meaning it to is the failure this guards.
var updateGolden = flag.Bool("update-golden", false,
	"rewrite the golden response files; read the diff before committing")

// Values that change every run, replaced so a diff shows contract changes
// rather than clock ticks.
//
// The masking has a cost worth naming: replacing a timestamp wholesale also
// hides its OFFSET, so these files would not have caught the day the wire
// carried +10:00 on a laptop and Z in a container.
// TestWireTimestampsAreUTCWhereverTheProcessRuns covers that instead.
var volatile = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`"(id|organisation_id)":"[0-9a-f-]{36}"`), `"$1":"<uuid>"`},
	{regexp.MustCompile(`"(next_action_at|last_contacted_at|quiet_since|timestamp)":"[^"]+"`), `"$1":"<timestamp>"`},
	{regexp.MustCompile(`"request_id":"[^"]+"`), `"request_id":"<request-id>"`},
	{regexp.MustCompile(`"(next_cursor|previous_cursor)":"[^"]+"`), `"$1":"<cursor>"`},
}

func stabilise(body []byte) []byte {
	for _, v := range volatile {
		body = v.pattern.ReplaceAll(body, []byte(v.replacement))
	}
	// Re-indented so a one-field change is a one-line diff rather than a
	// rewritten blob.
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, body, "", "  "); err != nil {
		return body
	}
	return append(pretty.Bytes(), '\n')
}

func assertGolden(t *testing.T, name string, body string) {
	t.Helper()
	path := filepath.Join("testdata", name+".json")
	got := stabilise([]byte(body))

	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("creating testdata: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v — run the tests with -update-golden to create it", path, err)
	}
	if string(got) != string(want) {
		t.Errorf("%s changed.\n\ngot:\n%s\nwant:\n%s\n\n"+
			"If this change is intended, re-run with -update-golden and commit the diff. "+
			"These files are the contract the console's parsers are written against.",
			path, got, want)
	}
}

func TestGoldenResponses(t *testing.T) {
	a := filterWorld(t)

	// A page size of 1 so the listing's golden file carries both cursors and a
	// non-zero preceding count — the parts of `meta` a single-page fixture
	// would leave unexercised.
	firstPage := a.get("/v1/crm/queues/due?limit=1")
	assertGolden(t, "due", firstPage.raw)

	secondPage := a.get("/v1/crm/queues/due?limit=1&cursor=" +
		firstPage.meta(t)["next_cursor"].(string))
	assertGolden(t, "due-second-page", secondPage.raw)

	// A row with every nullable field NULL — an unattributed lead with no
	// owner, which is the common shape after an import, not an edge case.
	assertGolden(t, "due-unattributed", a.get("/v1/crm/queues/due?product_unset=true&country_unset=true").raw)

	// Its own row, because every opportunity in filterWorld has a next action
	// scheduled and so nothing there can drift. Seeded here rather than in the
	// shared fixture: it is invisible to the due queue (a drifting row has no
	// next_action_at), so it cannot perturb the goldens above.
	a.opportunity(oppSpec{org: "Acme", label: "acme-quiet", product: ptr("mark8ly"),
		stage: domain.StageContacted, owner: ptr("Priya Raman"),
		lastContactedAt: a.ago(40 * day)})
	assertGolden(t, "drifting", a.get("/v1/crm/queues/drifting").raw)

	// The empty queue: [] rather than null, with both counts present as zero.
	assertGolden(t, "due-empty", a.get("/v1/crm/queues/due?product=nothing-by-this-name").raw)

	// The failures too. A client's error handling is written against these and
	// is exercised less than its success path, so a change here is likelier to
	// go unnoticed.
	assertGolden(t, "error-bad-cursor", a.get("/v1/crm/queues/due?cursor=nonsense").raw)
	assertGolden(t, "error-bad-filter", a.get("/v1/crm/queues/due?stage=archived").raw)
	assertGolden(t, "error-conflicting-axis", a.get("/v1/crm/queues/due?product=mark8ly&product_unset=true").raw)
	assertGolden(t, "error-unknown-parameter", a.get("/v1/crm/queues/due?stge=new").raw)
	assertGolden(t, "error-bad-limit", a.get("/v1/crm/queues/due?limit=0").raw)
}
