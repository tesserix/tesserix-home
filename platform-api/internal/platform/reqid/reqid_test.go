package reqid_test

import (
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
