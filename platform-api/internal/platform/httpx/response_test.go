package httpx_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid"
)

func discard() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// decode is deliberately into a map rather than into StandardResponse: these
// tests are about the WIRE shape, and unmarshalling through the same struct
// that produced it would agree with any renaming the struct did.
func decode(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, body)
	}
	return out
}

func TestSuccessIsTheEstateEnvelope(t *testing.T) {
	// go-shared's StandardResponse, field for field. A client written against
	// any of the other ~30 Tesserix services must not have to special-case
	// this one.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets/abc", nil)

	httpx.WriteData(rec, req, http.StatusOK, map[string]any{"ticket": map[string]any{"id": "abc"}}, discard())

	body := decode(t, rec.Body.Bytes())
	if body["success"] != true {
		t.Errorf("success = %v, want true", body["success"])
	}
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is missing or not an object: %v", body["data"])
	}
	if _, ok := data["ticket"]; !ok {
		t.Errorf("payload did not land under data: %v", data)
	}
	if _, present := body["error"]; present {
		t.Error("a success response carries no error key")
	}
	if _, present := body["timestamp"]; !present {
		t.Error("timestamp is part of the envelope and must always be present")
	}
}

func TestTimestampIsRFC3339UTC(t *testing.T) {
	// Parsed, not merely present. A timestamp nothing can parse is a string.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)

	httpx.WriteData(rec, req, http.StatusOK, struct{}{}, discard())

	raw, _ := decode(t, rec.Body.Bytes())["timestamp"].(string)
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t.Fatalf("timestamp %q is not RFC3339: %v", raw, err)
	}
	if parsed.Location() != time.UTC {
		t.Errorf("timestamp %q is not UTC — a mixed-zone trail cannot be ordered by eye", raw)
	}
}

func TestErrorIsTheEstateEnvelope(t *testing.T) {
	// The half that CHANGED. httpx shipped the flat AppError shape; the
	// decision recorded in errors.go moved it under `error` so the success and
	// failure sides of one API agree with each other.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets/nope", nil)

	httpx.WriteError(rec, req, httpx.NotFound("no such ticket"), discard())

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	body := decode(t, rec.Body.Bytes())
	if body["success"] != false {
		t.Errorf("success = %v, want false", body["success"])
	}
	if _, present := body["data"]; present {
		t.Error("a failure carries no data key")
	}
	details, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("error is missing or not an object: %v", body["error"])
	}
	if details["code"] != httpx.CodeNotFound {
		t.Errorf("error.code = %v, want %q", details["code"], httpx.CodeNotFound)
	}
	if details["message"] != "no such ticket" {
		t.Errorf("error.message = %v", details["message"])
	}
}

func TestTheStatusCodeIsNeverSerialised(t *testing.T) {
	// The property the flat envelope had and the nested one must keep: the
	// HTTP response already carries the status, and a body restating it invites
	// the two to disagree.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)

	httpx.WriteError(rec, req, httpx.Conflict("already replied"), discard())

	if strings.Contains(rec.Body.String(), "StatusCode") ||
		strings.Contains(rec.Body.String(), "status_code") {
		t.Errorf("the status leaked into the body: %s", rec.Body.String())
	}
}

func TestAnUnwrappedErrorNeverReachesTheClient(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)

	httpx.WriteError(rec, req, errDriver{}, discard())

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "platform_tickets") {
		t.Errorf("the driver's text leaked: %s", rec.Body.String())
	}
}

type errDriver struct{}

func (errDriver) Error() string { return `pq: relation "platform_tickets" does not exist` }

func TestRequestIDIsEchoedIntoTheEnvelope(t *testing.T) {
	// The field exists in the estate's envelope; leaving it permanently empty
	// would be a column of blanks in every log correlation anyone attempted.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	req.Header.Set(reqid.Header, "abc-123")

	reqid.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteData(w, r, http.StatusOK, struct{}{}, discard())
	})).ServeHTTP(rec, req)

	if got := decode(t, rec.Body.Bytes())["request_id"]; got != "abc-123" {
		t.Errorf("request_id = %v, want the inbound id echoed back", got)
	}
}

func TestRequestIDIsAlsoOnFailures(t *testing.T) {
	// The response an operator screenshots is usually the failing one, so this
	// is the direction that matters.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	req.Header.Set(reqid.Header, "abc-123")

	reqid.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteError(w, r, httpx.Internal("request failed"), discard())
	})).ServeHTTP(rec, req)

	if got := decode(t, rec.Body.Bytes())["request_id"]; got != "abc-123" {
		t.Errorf("request_id = %v on a failure, want the inbound id", got)
	}
}

func TestMetaCarriesTheKeysetPageAndNotAPageNumber(t *testing.T) {
	// #240/#241 standardised the console on keyset. go-shared's MetaData is
	// offset-shaped (page/per_page/total_pages), and emitting those alongside
	// a cursor would offer a client a position this API cannot honour.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	total := int64(128)
	preceding := 50

	httpx.WriteMeta(rec, req, http.StatusOK, struct{}{}, &httpx.Meta{
		NextCursor:     "YWZ0ZXI=",
		PreviousCursor: "YmVmb3Jl",
		PrecedingCount: &preceding,
		Total:          &total,
		Limit:          50,
	}, discard())

	meta, ok := decode(t, rec.Body.Bytes())["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta is missing: %s", rec.Body.String())
	}
	for _, forbidden := range []string{"page", "per_page", "total_pages"} {
		if _, present := meta[forbidden]; present {
			t.Errorf("meta carries %q — this API pages by cursor and cannot honour a page number", forbidden)
		}
	}
	if meta["next_cursor"] != "YWZ0ZXI=" || meta["previous_cursor"] != "YmVmb3Jl" {
		t.Errorf("cursors did not survive: %v", meta)
	}
	if meta["total"] != float64(128) || meta["preceding_count"] != float64(50) {
		t.Errorf("counts did not survive: %v", meta)
	}
}

func TestAnEmptyPageStillReportsItsTotalAndPosition(t *testing.T) {
	// The honest-totals half of #241. `omitempty` on a plain int would drop a
	// zero, and a client cannot tell "no rows match" from "this API does not
	// report totals" — so both are pointers.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	total := int64(0)
	preceding := 0

	httpx.WriteMeta(rec, req, http.StatusOK, []struct{}{}, &httpx.Meta{
		Total:          &total,
		PrecedingCount: &preceding,
		Limit:          50,
	}, discard())

	meta := decode(t, rec.Body.Bytes())["meta"].(map[string]any)
	if got, present := meta["total"]; !present || got != float64(0) {
		t.Errorf("total = %v (present=%v), want a serialised 0", got, present)
	}
	if got, present := meta["preceding_count"]; !present || got != float64(0) {
		t.Errorf("preceding_count = %v (present=%v), want a serialised 0", got, present)
	}
}

func TestTheLastPageOmitsItsCursor(t *testing.T) {
	// A cursor is a promise there is more. An empty string would be a promise
	// that resolves to nothing, so the key is absent instead.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)

	httpx.WriteMeta(rec, req, http.StatusOK, []struct{}{}, &httpx.Meta{Limit: 50}, discard())

	meta := decode(t, rec.Body.Bytes())["meta"].(map[string]any)
	for _, key := range []string{"next_cursor", "previous_cursor"} {
		if _, present := meta[key]; present {
			t.Errorf("%s is present on a page that has none", key)
		}
	}
}

func TestAnUnencodablePayloadFailsAsA500RatherThanACorruptSuccess(t *testing.T) {
	// Encoding into a buffer first is what makes this possible: writing
	// straight to the ResponseWriter commits 200 before the encode can fail,
	// producing a truncated body under a success status.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)

	httpx.WriteData(rec, req, http.StatusOK, map[string]any{"fn": func() {}}, discard())

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	body := decode(t, rec.Body.Bytes())
	if body["success"] != false {
		t.Errorf("the fallback body is not the envelope: %s", rec.Body.String())
	}
}

// The auth package writes its own 401 and 403 bodies, because httpx imports
// auth and the reverse edge would be a cycle. Nothing over there can compare
// the two shapes; this can.
//
// A refusal shaped differently from every other failure is the response a
// client is least able to anticipate — it is the one it meets before it has
// successfully parsed anything else — so the two must not drift.
func TestRefusalsMatchTheAuthPackage(t *testing.T) {
	fromHTTPX := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	httpx.WriteError(fromHTTPX, req, httpx.Unauthorized("authentication required"), discard())

	// auth refuses a request carrying no Authorization header.
	fromAuth := httptest.NewRecorder()
	auth.Authenticate(&auth.Verifier{}, discard(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("an unauthenticated request must not reach the handler")
	})).ServeHTTP(fromAuth, httptest.NewRequest(http.MethodGet, "/v1/tickets", nil))

	if fromAuth.Code != fromHTTPX.Code {
		t.Errorf("auth refuses with %d, httpx with %d", fromAuth.Code, fromHTTPX.Code)
	}
	if got, want := fromAuth.Header().Get("Content-Type"), fromHTTPX.Header().Get("Content-Type"); got != want {
		t.Errorf("Content-Type differs: auth %q, httpx %q", got, want)
	}

	theirs, ours := decode(t, fromAuth.Body.Bytes()), decode(t, fromHTTPX.Body.Bytes())
	if theirs["success"] != ours["success"] {
		t.Errorf("success differs: auth %v, httpx %v", theirs["success"], ours["success"])
	}
	// Key sets, not values: the two carry different timestamps and neither
	// carries a request id here, but a field present in one and absent from
	// the other is the drift this test exists for.
	for _, key := range []string{"success", "error", "timestamp"} {
		if _, present := theirs[key]; !present {
			t.Errorf("auth's refusal is missing %q", key)
		}
	}
	if _, present := theirs["data"]; present {
		t.Error("auth's refusal carries a data key; a failure must not")
	}

	theirErr, ok := theirs["error"].(map[string]any)
	if !ok {
		t.Fatalf("auth's error is not an object: %v", theirs["error"])
	}
	ourErr := ours["error"].(map[string]any)
	if theirErr["code"] != ourErr["code"] {
		t.Errorf("code differs: auth %v, httpx %v", theirErr["code"], ourErr["code"])
	}
	if _, present := theirErr["message"]; !present {
		t.Error("auth's error carries no message")
	}
}
