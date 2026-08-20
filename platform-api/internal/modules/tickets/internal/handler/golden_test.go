package handler_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// Golden responses: the module's actual output, committed.
//
// # What they are for
//
// #269 requires the console's four ticket call sites to migrate onto this
// module, and #271 built the equivalence harness for it — apps/console/dev/
// admin-stub.test.ts runs the console's OWN parsers over the stub, so a drift
// between the contract and the parsers is a failing test rather than a
// discovery in production.
//
// These files are the other half of that harness. The console's parsers cannot
// run against a Go process in CI, but they can run against its recorded
// output, and this is that output — produced by the real router, over a real
// database, through the real envelope. When the console's parsers are written
// against this module (the migration is a follow-up to this branch, so nothing
// consumes these yet), these files are what they are written against and what
// a change to this module would break.
//
// # Why committed rather than generated on demand
//
// A generated fixture proves the generator agrees with itself. A committed one
// makes a contract change VISIBLE IN A DIFF — which is the whole point for a
// contract products will pin to. Regenerate deliberately:
//
//	go test ./internal/modules/tickets/... -update-golden
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
// TestWireTimestampsAreUTCWhereverTheProcessRuns covers that instead. Everything replaced here is a value whose SHAPE is
// asserted elsewhere — the envelope tests check the timestamp parses and the
// request id is echoed; these files are about field names and nesting.
var volatile = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`"(id|ticket_id)":"[0-9a-f-]{36}"`), `"$1":"<uuid>"`},
	{regexp.MustCompile(`"tenant_id":"[0-9a-f-]{36}"`), `"tenant_id":"<uuid>"`},
	{regexp.MustCompile(`"(created_at|updated_at|resolved_at|timestamp)":"[^"]+"`), `"$1":"<timestamp>"`},
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
	a := serve(t, tokenFor("read", "support", "respond"))
	first := a.seedTicket("s1", "open", "urgent")
	a.seedTicket("s2", "closed", "low")

	reply := a.do(http.MethodPost, "/v1/tickets/"+first+"/replies",
		`{"content":"Looking into this now."}`, nil)
	if reply.status != http.StatusCreated {
		t.Fatalf("seeding a reply: %s", reply.raw)
	}

	// A page size of 1 so the listing's golden file carries both cursors and a
	// non-zero preceding count — the parts of `meta` an empty or single-page
	// fixture would leave unexercised.
	firstPage := a.get("/v1/tickets?limit=1")
	assertGolden(t, "list", firstPage.raw)

	secondPage := a.get("/v1/tickets?limit=1&cursor=" +
		firstPage.body["meta"].(map[string]any)["next_cursor"].(string))
	assertGolden(t, "list-second-page", secondPage.raw)

	assertGolden(t, "summary", a.get("/v1/tickets/summary").raw)
	assertGolden(t, "detail", a.get("/v1/tickets/"+first).raw)
	assertGolden(t, "reply", reply.raw)
	assertGolden(t, "status", a.do(http.MethodPatch, "/v1/tickets/"+first, `{"status":"resolved"}`, nil).raw)

	// The failures too. A client's error handling is written against these and
	// is exercised less than its success path, so a change here is likelier to
	// go unnoticed.
	assertGolden(t, "error-not-found", a.get("/v1/tickets/3f2a1c94-0000-4000-8000-000000000999").raw)
	assertGolden(t, "error-bad-cursor", a.get("/v1/tickets?cursor=nonsense").raw)
	assertGolden(t, "error-refused", a.do(http.MethodPatch, "/v1/tickets/"+first, `{"status":"resolved"}`, nil).raw)
	// #302: a misspelled query parameter, on both routes that read one.
	assertGolden(t, "error-unknown-parameter", a.get("/v1/tickets?stge=new").raw)
	assertGolden(t, "error-unknown-summary-parameter", a.get("/v1/tickets/summary?anything=x").raw)
}

func TestGoldenRefusals(t *testing.T) {
	// Its own test because it needs a different principal: the capability
	// refusal is the response a client meets when a role was revoked, and its
	// shape is what tells the console to send the operator to a permissions
	// message rather than to a retry.
	a := serve(t, tokenFor("read"))

	assertGolden(t, "error-forbidden", a.get("/v1/tickets").raw)
}
