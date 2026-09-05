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
// written against its RECORDED output — produced by the real router, the real
// verifier and a stub product answering mark8ly's own golden bytes, through
// the real envelope. Committed rather than generated on demand so a contract
// change is VISIBLE IN A DIFF.
//
//	go test ./internal/modules/emailtemplates/internal/handler/... -update-golden
//
// Scoped to this package: the domain and service packages build their own test
// binaries, which do not define this flag.
var updateGolden = flag.Bool("update-golden", false,
	"rewrite the golden response files; read the diff before committing")

// Values that change every run, replaced so a diff shows contract changes
// rather than clock ticks. `updated_at` is deliberately NOT in this list: it
// comes from the product's fixture and is fixed, and masking it would hide the
// one field whose round trip through time.Time could change its spelling.
var volatile = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`"timestamp":"[^"]+"`), `"timestamp":"<timestamp>"`},
	{regexp.MustCompile(`"request_id":"[^"]+"`), `"request_id":"<request-id>"`},
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

	assertGolden(t, "list", a.get("/v1/email-templates").raw)
	assertGolden(t, "detail", a.get("/v1/email-templates/"+invoiceID).raw)
	assertGolden(t, "saved", a.put("/v1/email-templates/"+invoiceID, validSave).raw)
	assertGolden(t, "test-send",
		a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`).raw)

	// A partial listing. The console renders this differently from an empty
	// one, and it is the shape it will see during an outage — which is when
	// nobody is reading a golden file.
	failing := serveWith(t, refusing(http.StatusInternalServerError, `{"error":"internal_error"}`),
		[]string{productSlug}, "platform")
	assertGolden(t, "list-source-failed", failing.get("/v1/email-templates").raw)

	// Every error shape. A client's error handling is written against these
	// and exercised less than its success path, so a change here is likelier
	// to go unnoticed.
	assertGolden(t, "error-unknown-parameter", a.get("/v1/email-templates?sorce=mark8ly").raw)
	assertGolden(t, "error-unknown-source", a.get("/v1/email-templates?source=nosuch").raw)
	assertGolden(t, "error-bare-key", a.get("/v1/email-templates/orderdoc_invoice").raw)
	assertGolden(t, "error-no-idempotency-key",
		a.do(http.MethodPut, "/v1/email-templates/"+invoiceID, validSave, nil).raw)
	assertGolden(t, "error-unknown-field",
		a.put("/v1/email-templates/"+invoiceID, `{"subject":"s","htmlBody":"x","text_body":"t"}`).raw)
	assertGolden(t, "error-no-recipient",
		a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":""}`).raw)

	// 501, the state every deployment is in until `email-templates` is
	// declared in FEDERATION_<SLUG>_ENDPOINTS. The console renders this status
	// and no other as "not wired yet".
	assertGolden(t, "error-not-instrumented", serveNoProducts(t).get("/v1/email-templates").raw)

	// The product's own refusals, each mapped to its own status and sentence.
	for _, c := range []struct {
		name   string
		status int
		body   string
	}{
		{"error-unknown-key", http.StatusNotFound, `{"error":"unknown_key","message":"no template"}`},
		{"error-invalid-template", http.StatusBadRequest, `{"error":"invalid_template","message":"braces"}`},
		{"error-render-failed", http.StatusUnprocessableEntity, `{"error":"render_failed","message":"no StoreName"}`},
		{"error-not-configured", http.StatusServiceUnavailable, `{"error":"not_configured","message":"no sender"}`},
		{"error-send-failed", http.StatusBadGateway, `{"error":"send_failed","message":"provider said no"}`},
	} {
		refuser := serveWith(t, refusing(c.status, c.body), []string{productSlug}, "platform", "mass-send")
		assertGolden(t, c.name,
			refuser.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`).raw)
	}
}
