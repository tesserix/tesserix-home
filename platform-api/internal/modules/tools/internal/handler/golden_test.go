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
// The console's parsers cannot run against a Go process in CI, but they can be
// written against its RECORDED output — produced by the real router, over a
// real database, through the real envelope. Committed rather than generated on
// demand so a contract change is VISIBLE IN A DIFF.
//
//	go test ./internal/modules/tools/internal/handler/... -update-golden
//
// Scoped to this package: the domain and repository packages build their own
// test binaries, which do not define this flag.
var updateGolden = flag.Bool("update-golden", false,
	"rewrite the golden response files; read the diff before committing")

var volatile = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`"id":"[0-9a-f-]{36}"`), `"id":"<uuid>"`},
	{regexp.MustCompile(`"timestamp":"[^"]+"`), `"timestamp":"<timestamp>"`},
	{regexp.MustCompile(`"request_id":"[^"]+"`), `"request_id":"<request-id>"`},
}

func stabilise(body []byte) []byte {
	for _, v := range volatile {
		body = v.pattern.ReplaceAll(body, []byte(v.replacement))
	}
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
		t.Fatalf("reading %s: %v — run with -update-golden to create it", path, err)
	}
	if string(got) != string(want) {
		t.Errorf("%s changed.\n\ngot:\n%s\nwant:\n%s\n\n"+
			"If this change is intended, re-run with -update-golden and commit the diff. "+
			"These files are the contract the console's parser is written against.",
			path, got, want)
	}
}

func TestGoldenResponses(t *testing.T) {
	a := serve(t)

	assertGolden(t, "tools", a.get("/v1/platform/tools").raw)
	assertGolden(t, "tool-groups", a.get("/v1/platform/tool-groups").raw)

	created := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Distributed traces.","group_key":"observability"}`, nil)
	assertGolden(t, "tool-created", created.raw)

	id := a.toolID("tempo")
	assertGolden(t, "tool-updated",
		a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"purpose":"Traces, distributed."}`, nil).raw)
	assertGolden(t, "tool-deleted",
		a.do(http.MethodDelete, "/v1/platform/tools/"+id, "", nil).raw)

	assertGolden(t, "group-created",
		a.do(http.MethodPost, "/v1/platform/tool-groups", `{"key":"security","label":"Security"}`, nil).raw)
	assertGolden(t, "group-updated",
		a.do(http.MethodPatch, "/v1/platform/tool-groups/security", `{"label":"Sec"}`, nil).raw)
	// A throwaway empty group, created and then deleted, so the seeded five
	// other goldens read from stay untouched.
	a.do(http.MethodPost, "/v1/platform/tool-groups", `{"key":"scratch","label":"Scratch"}`, nil)
	assertGolden(t, "group-deleted",
		a.do(http.MethodDelete, "/v1/platform/tool-groups/scratch", "", nil).raw)

	// Every error shape. A client's error handling is written against these
	// and exercised less than its success path, so a change here is likelier
	// to go unnoticed.
	assertGolden(t, "error-unknown-parameter", a.get("/v1/platform/tools?group=identity").raw)
	assertGolden(t, "error-subdomain-not-a-label",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"https://grafana.tesserix.app","purpose":"x","group_key":"reference"}`, nil).raw)
	assertGolden(t, "error-unknown-group",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"x","purpose":"x","group_key":"no-such-group"}`, nil).raw)
	assertGolden(t, "error-duplicate-subdomain",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"auth","purpose":"x","group_key":"identity"}`, nil).raw)
	assertGolden(t, "error-unknown-field",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"x","purpose":"x","group_key":"reference","status":"up"}`, nil).raw)
	assertGolden(t, "error-tool-not-found",
		a.do(http.MethodPatch, "/v1/platform/tools/00000000-0000-0000-0000-000000000000",
			`{"name":"x"}`, nil).raw)
	assertGolden(t, "error-group-has-tools",
		a.do(http.MethodDelete, "/v1/platform/tool-groups/identity", "", nil).raw)
	assertGolden(t, "error-group-key-immutable",
		a.do(http.MethodPatch, "/v1/platform/tool-groups/cost", `{"key":"spend"}`, nil).raw)
	assertGolden(t, "error-group-not-found",
		a.do(http.MethodPatch, "/v1/platform/tool-groups/no-such-group", `{"label":"x"}`, nil).raw)
	assertGolden(t, "error-duplicate-group",
		a.do(http.MethodPost, "/v1/platform/tool-groups", `{"key":"identity","label":"Another identity"}`, nil).raw)
}
