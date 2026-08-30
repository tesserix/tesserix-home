package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// merchantEmail is the PII this module must never let into a log line, an
// error string, or anything else that is not the response body. Every test
// below that asserts about leakage looks for exactly this value.
const merchantEmail = "priya@handloomsofkerala.example"

// liveSessions is a page as mark8ly serves it today: the row shape
// platformadmin.sessionRow projects, and the page/limit/total block beside it.
const liveSessions = `{"data":[` +
	`{"id":"sess-1","email":"` + merchantEmail + `","status":"in_progress",` +
	`"created_at":"2026-08-29T10:00:00Z","last_activity_at":"2026-08-29T10:04:00Z",` +
	`"idle_hours":19.5,"abandoned":true,"completed_at":null,"tenant_id":null}` +
	`],"pagination":{"page":1,"limit":50,"total":137}}`

// sessionsAnswering builds a service over one product returning the given
// status/body, and hands back the buffer its logger writes to so a test can
// assert on what was and was not logged.
func sessionsAnswering(t *testing.T, status int, body string) (*Service, *bytes.Buffer) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: mark8ly, BaseURL: srv.URL, Secret: "s", Endpoints: []string{"onboarding"}},
	}), srv.Client())
	var logged bytes.Buffer
	return New(fed, []string{mark8ly}, slog.New(slog.NewTextHandler(&logged, nil))), &logged
}

func listSessions(t *testing.T, s *Service, query url.Values) (json.RawMessage, Page, error) {
	t.Helper()
	return s.ListSessions(context.Background(), op(), mark8ly, query)
}

func TestListSessionsForwardsTheProductsRowsVerbatim(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusOK, liveSessions)
	rows, page, err := listSessions(t, svc, nil)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(rows, &decoded); err != nil {
		t.Fatalf("rows are not an array: %v (%s)", err, rows)
	}
	if len(decoded) != 1 || decoded[0]["id"] != "sess-1" || decoded[0]["email"] != merchantEmail {
		t.Errorf("rows = %v, want mark8ly's own row", decoded)
	}
	if page.Total != 137 || page.Limit != 50 {
		t.Errorf("page = %+v, want total 137 limit 50", page)
	}
}

// The same rule the funnel obeys, applied to a row: mark8ly's vocabulary
// reaches the console verbatim. A sessionRow struct here would silently drop
// any field mark8ly adds — and it would have INVENTED one, because
// `email_verified_at` exists on mark8ly's internal Session type and is
// deliberately not projected onto the wire.
func TestListSessionsForwardsAFieldThisModuleHasNeverHeardOf(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusOK, `{"data":[`+
		`{"id":"s1","email":"a@b.example","status":"in_progress","referral_code":"HANDLOOM24"}`+
		`],"pagination":{"page":1,"limit":50,"total":1}}`)
	rows, _, err := listSessions(t, svc, nil)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if !strings.Contains(string(rows), `"referral_code":"HANDLOOM24"`) {
		t.Errorf("rows = %s, want the unknown field carried through verbatim", rows)
	}
}

// THE assertion this route exists to keep honest, half one: nobody signed up
// is a MEASUREMENT and must succeed with an empty array.
func TestAnEmptyListIsAnAnswerAndNotAFailure(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusOK,
		`{"data":[],"pagination":{"page":1,"limit":50,"total":0}}`)
	rows, page, err := listSessions(t, svc, nil)
	if err != nil {
		t.Fatalf("ListSessions: %v, want an empty page to be a success", err)
	}
	if string(rows) != "[]" {
		t.Errorf("rows = %s, want []", rows)
	}
	if page.Total != 0 {
		t.Errorf("total = %d, want 0", page.Total)
	}
}

// Half two: a read that did not produce a list must never wear the clothes of
// an empty one. Each of these decodes to "no rows" one layer down.
func TestAListThatCouldNotBeReadIsNeverAnEmptyList(t *testing.T) {
	for name, body := range map[string]string{
		"data is null":         `{"data":null,"pagination":{"page":1,"limit":50,"total":0}}`,
		"data is absent":       `{"pagination":{"page":1,"limit":50,"total":0}}`,
		"data is an object":    `{"data":{},"pagination":{"page":1,"limit":50,"total":0}}`,
		"body is not JSON":     `<html>502 Bad Gateway</html>`,
		"pagination is absent": `{"data":[]}`,
		"total is absent":      `{"data":[],"pagination":{"page":1,"limit":50}}`,
	} {
		t.Run(name, func(t *testing.T) {
			svc, _ := sessionsAnswering(t, http.StatusOK, body)
			rows, _, err := listSessions(t, svc, nil)
			if !errors.Is(err, ErrSessionsUnreadable) {
				t.Fatalf("err = %v, want ErrSessionsUnreadable; rows = %s", err, rows)
			}
			if rows != nil {
				t.Errorf("rows = %s, want nothing at all alongside the error", rows)
			}
		})
	}
}

// An outage is not an empty queue either. It reaches the handler as a wrapped
// error, which the handler renders 503.
func TestATransportFailureIsNeverAnEmptyList(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusBadGateway, `{"error":"bad_gateway"}`)
	rows, _, err := listSessions(t, svc, nil)
	if err == nil {
		t.Fatalf("err = nil, want a failure; rows = %s", rows)
	}
	if rows != nil {
		t.Errorf("rows = %s, want nothing at all alongside the error", rows)
	}
}

// The product declared `onboarding` and does not mount the route. Kept
// distinct so whoever debugs it sees a declaration problem, not an outage.
func TestA404IsAMissingSessionList(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusNotFound, `{"error":"not_found"}`)
	if _, _, err := listSessions(t, svc, nil); !errors.Is(err, ErrNoSessionList) {
		t.Errorf("err = %v, want ErrNoSessionList", err)
	}
}

func TestAnUnknownSourceIsRefusedBeforeAnyCall(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusOK, liveSessions)
	_, _, err := svc.ListSessions(context.Background(), op(), "kora", nil)
	if !errors.Is(err, ErrUnknownSource) {
		t.Errorf("err = %v, want ErrUnknownSource", err)
	}
}

func TestNoProductDeclaringOnboardingIsItsOwnAnswer(t *testing.T) {
	svc, _ := sessionsAnswering(t, http.StatusOK, liveSessions)
	svc.slugs = nil
	if _, _, err := listSessions(t, svc, nil); !errors.Is(err, ErrNoProducts) {
		t.Errorf("err = %v, want ErrNoProducts", err)
	}
}

// PII, half one. A body that fails the invariants is the most tempting thing
// in this file to quote back — and a rejected sessions body is a page of
// merchant email addresses. The error must name the source and nothing else.
func TestAnUnreadableBodyNeverAppearsInTheError(t *testing.T) {
	for name, body := range map[string]string{
		"a row where the list should be": `{"data":{"id":"s1","email":"` + merchantEmail +
			`"},"pagination":{"total":1}}`,
		"a body truncated mid-row": `{"data":[{"id":"s1","email":"` + merchantEmail + `"`,
		"a row where a number should be": `{"data":[{"email":"` + merchantEmail +
			`"}],"pagination":{"page":1,"limit":"` + merchantEmail + `","total":1}}`,
	} {
		t.Run(name, func(t *testing.T) {
			svc, _ := sessionsAnswering(t, http.StatusOK, body)
			_, _, err := listSessions(t, svc, nil)
			if err == nil {
				t.Fatal("err = nil, want ErrSessionsUnreadable")
			}
			if strings.Contains(err.Error(), merchantEmail) || strings.Contains(err.Error(), "@") {
				t.Errorf("error quotes the rejected body: %v", err)
			}
		})
	}
}

// PII, half two. Every failure path writes to the logger before returning, and
// none of them may write a row.
func TestNoFailurePathLogsASessionRow(t *testing.T) {
	bodies := map[string]struct {
		status int
		body   string
	}{
		"an unreadable 200": {http.StatusOK,
			`{"data":{"email":"` + merchantEmail + `"},"pagination":{"total":1}}`},
		// A refusal whose body is a page of rows: nothing requires a product's
		// error body to be an error envelope, and federation reads it before
		// deciding the status was a refusal.
		"a refusal carrying rows": {http.StatusInternalServerError, liveSessions},
		"a refusal carrying an error envelope": {http.StatusBadGateway,
			`{"error":"upstream_unavailable","message":"` + merchantEmail + `"}`},
		"a body truncated mid-row": {http.StatusOK,
			`{"data":[{"id":"s1","email":"` + merchantEmail + `"`},
	}
	for name, c := range bodies {
		t.Run(name, func(t *testing.T) {
			svc, logged := sessionsAnswering(t, c.status, c.body)
			if _, _, err := listSessions(t, svc, nil); err == nil {
				t.Fatal("err = nil, want a failure")
			}
			if strings.Contains(logged.String(), merchantEmail) {
				t.Errorf("a merchant email reached the log: %s", logged.String())
			}
			if strings.Contains(logged.String(), "@handloomsofkerala") {
				t.Errorf("a fragment of a merchant email reached the log: %s", logged.String())
			}
			// Without this the test passes for a module that logs nothing at
			// all, which would make every assertion above vacuous. Each of
			// these cases must produce a log line, and that line must be clean
			// — not be absent.
			if logged.Len() == 0 {
				t.Error("nothing was logged; the assertions above would pass for any silent failure")
			}
		})
	}
}

// The query the handler narrowed is forwarded exactly, because the response's
// pagination echo is only true if this layer did not rewrite the request.
func TestTheNarrowedQueryReachesTheProductUnchanged(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(liveSessions))
	}))
	t.Cleanup(srv.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: mark8ly, BaseURL: srv.URL, Secret: "s", Endpoints: []string{"onboarding"}},
	}), srv.Client())
	svc := New(fed, []string{mark8ly}, testLogger())

	if _, _, err := listSessions(t, svc, url.Values{
		"status": {"in_progress"}, "abandoned": {"true"}, "limit": {"25"},
	}); err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	for _, want := range []string{"status=in_progress", "abandoned=true", "limit=25"} {
		if !strings.Contains(gotQuery, want) {
			t.Errorf("query = %q, want it to contain %q", gotQuery, want)
		}
	}
}
