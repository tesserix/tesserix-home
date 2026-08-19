package reqid_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid"
)

func capture(t *testing.T, req *http.Request) (seen string, rec *httptest.ResponseRecorder) {
	t.Helper()
	rec = httptest.NewRecorder()
	reqid.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = reqid.FromContext(r.Context())
	})).ServeHTTP(rec, req)
	return seen, rec
}

func TestAnInboundIDIsCarriedThrough(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(reqid.Header, "console-7f3a")

	seen, rec := capture(t, req)

	if seen != "console-7f3a" {
		t.Errorf("context id = %q, want the inbound value", seen)
	}
	if got := rec.Header().Get(reqid.Header); got != "console-7f3a" {
		t.Errorf("response header = %q, want it echoed", got)
	}
}

func TestAnAbsentIDIsGenerated(t *testing.T) {
	seen, rec := capture(t, httptest.NewRequest(http.MethodGet, "/", nil))

	if seen == "" {
		t.Fatal("no id was generated; a request with no id is the common case, not an exception")
	}
	if rec.Header().Get(reqid.Header) != seen {
		t.Error("the generated id was not echoed on the response")
	}
}

func TestGeneratedIDsDiffer(t *testing.T) {
	// A constant would satisfy every other test here and correlate nothing.
	first, _ := capture(t, httptest.NewRequest(http.MethodGet, "/", nil))
	second, _ := capture(t, httptest.NewRequest(http.MethodGet, "/", nil))

	if first == second {
		t.Errorf("two requests got the same id (%q); ids must identify a request", first)
	}
}

func TestAnOverlongInboundIDIsReplaced(t *testing.T) {
	// The value is attacker-controlled and lands in every log line for the
	// request. Replaced rather than truncated: a truncated id silently stops
	// matching the caller's own record.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	long := strings.Repeat("a", 500)
	req.Header.Set(reqid.Header, long)

	seen, _ := capture(t, req)

	if seen == long {
		t.Error("an unbounded caller-supplied id was accepted")
	}
	if strings.HasPrefix(seen, "aaaa") {
		t.Errorf("the id was truncated rather than replaced: %q", seen)
	}
}

func TestAnIDCarryingControlCharactersIsReplaced(t *testing.T) {
	// This one is not hygiene. The value is written into a response header,
	// where a CR or LF is a response-splitting primitive.
	for _, hostile := range []string{"abc\r\nX-Evil: 1", "abc\ndef", "abc\x00def"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set(reqid.Header, hostile)

		seen, rec := capture(t, req)

		if strings.ContainsAny(seen, "\r\n\x00") {
			t.Errorf("control characters survived into the id: %q", seen)
		}
		if strings.ContainsAny(rec.Header().Get(reqid.Header), "\r\n") {
			t.Errorf("control characters reached the response header for input %q", hostile)
		}
	}
}

func TestFromContextIsEmptyWithoutTheMiddleware(t *testing.T) {
	// Handlers must treat this as "omit the field", never as a value worth
	// asserting on — which is why it is "" and not a panic.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := reqid.FromContext(req.Context()); got != "" {
		t.Errorf("FromContext with no middleware = %q, want empty", got)
	}
}

// The defect these cover was found by running the service, not by the tests
// that existed at the time: every log call passed a context carrying an id,
// and not one log line contained it. slog handlers do not read context values.

func logWith(t *testing.T, ctx context.Context, emit func(*slog.Logger, context.Context)) string {
	t.Helper()
	var buf bytes.Buffer
	log := slog.New(reqid.LogHandler(slog.NewJSONHandler(&buf, nil)))
	emit(log, ctx)
	return buf.String()
}

func TestALogCallWithARequestContextCarriesTheID(t *testing.T) {
	var captured context.Context
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tickets", nil)
	req.Header.Set(reqid.Header, "console-7f3a")
	reqid.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = r.Context()
	})).ServeHTTP(rec, req)

	line := logWith(t, captured, func(l *slog.Logger, ctx context.Context) {
		l.WarnContext(ctx, "token rejected")
	})

	if !strings.Contains(line, `"request_id":"console-7f3a"`) {
		t.Errorf("the id did not reach the log line: %s", line)
	}
}

func TestALogCallWithNoRequestContextIsUnchanged(t *testing.T) {
	// Startup lines have no request. An empty request_id on them would be a
	// column of blanks that a log query still has to filter out.
	line := logWith(t, context.Background(), func(l *slog.Logger, ctx context.Context) {
		l.InfoContext(ctx, "listening")
	})

	if strings.Contains(line, "request_id") {
		t.Errorf("a non-request log line gained a request_id: %s", line)
	}
}

func TestTheIDIsNotBuriedInsideAGroup(t *testing.T) {
	// A handler that applied the caller's group to the id would nest it under
	// whatever key was open at the time, and an id three keys deep is one a
	// log query will not find.
	var captured context.Context
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(reqid.Header, "console-7f3a")
	reqid.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = r.Context()
	})).ServeHTTP(httptest.NewRecorder(), req)

	var buf bytes.Buffer
	log := slog.New(reqid.LogHandler(slog.NewJSONHandler(&buf, nil))).WithGroup("upstream")
	log.WarnContext(captured, "failed", slog.String("host", "zitadel"))

	var decoded map[string]any
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, buf.String())
	}
	if decoded["request_id"] != "console-7f3a" {
		t.Errorf("request_id is not at the top level: %s", buf.String())
	}
	group, _ := decoded["upstream"].(map[string]any)
	if group == nil || group["host"] != "zitadel" {
		t.Errorf("the caller's group was lost: %s", buf.String())
	}
}

func TestTheRecordHandedToTheInnerHandlerIsNotMutated(t *testing.T) {
	// Handle must not modify the record it is given; a chained handler
	// downstream may hold a reference to it.
	var captured context.Context
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(reqid.Header, "abc")
	reqid.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		captured = r.Context()
	})).ServeHTTP(httptest.NewRecorder(), req)

	spy := &recordingHandler{}
	slog.New(reqid.LogHandler(spy)).WarnContext(captured, "once")

	if spy.seen != 1 {
		t.Fatalf("inner handler saw %d records, want 1", spy.seen)
	}
	if spy.attrs != 1 {
		t.Errorf("inner record carried %d attrs, want exactly the request id", spy.attrs)
	}
}

type recordingHandler struct {
	seen  int
	attrs int
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.seen++
	r.Attrs(func(slog.Attr) bool { h.attrs++; return true })
	return nil
}
func (h *recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *recordingHandler) WithGroup(string) slog.Handler      { return h }
