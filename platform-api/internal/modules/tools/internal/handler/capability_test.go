package handler_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/handler"
)

// The pair §9 requires, and the enumeration that keeps them honest.
//
// Neither test is worth anything alone: a refusal test on its own is satisfied
// by a route that does not exist, because a 403 from a mistyped path looks
// exactly like a 403 from the capability gate. The companion sends the SAME
// requests with the capability present and insists they work.

type routeCase struct {
	// body is empty for a read.
	body string
	// want is the status the same request produces once the capability is
	// there. Named per route rather than assumed to be 200, so a 201 does not
	// have to weaken the assertion to "anything but 403" — which would let a
	// 500 pass for a success.
	want int
}

// routeCases is one entry per route in handler.RouteTable, keyed by
// "METHOD /pattern" exactly as the table spells it.
//
// This map is the fail-closed half: both tests range over RouteTable and FAIL
// on an entry with no case here, so a ninth route cannot be served untested.
func routeCases() map[string]routeCase {
	return map[string]routeCase{
		"GET /v1/platform/tools":       {want: http.StatusOK},
		"GET /v1/platform/tool-groups": {want: http.StatusOK},
		// The writes answer 501 until Task 4. The point of the case is the
		// REFUSAL half — a stub must be behind the gate too — and `want` is
		// updated to 201/200/200 when the writes land.
		"POST /v1/platform/tools": {
			body: `{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`,
			want: http.StatusNotImplemented,
		},
		"PATCH /v1/platform/tools/{id}": {
			body: `{"purpose":"Changed."}`,
			want: http.StatusNotImplemented,
		},
		"DELETE /v1/platform/tools/{id}": {want: http.StatusNotImplemented},
		"POST /v1/platform/tool-groups": {
			body: `{"key":"security","label":"Security"}`,
			want: http.StatusNotImplemented,
		},
		"PATCH /v1/platform/tool-groups/{key}": {
			body: `{"label":"Changed"}`,
			want: http.StatusNotImplemented,
		},
		"DELETE /v1/platform/tool-groups/{key}": {want: http.StatusNotImplemented},
	}
}

func caseFor(t *testing.T, route handler.Route) routeCase {
	t.Helper()
	key := route.Method + " " + route.Pattern
	c, ok := routeCases()[key]
	if !ok {
		t.Fatalf("%s is registered but has no capability case; add it to routeCases so "+
			"the route is proved to refuse a principal without `platform` AND to answer "+
			"one that holds it", key)
	}
	return c
}

// path fills a pattern in with real identifiers from the seed, not
// plausible-looking strings: a 404 from a nonexistent row would mask the very
// difference the companion test exists to show.
func path(t *testing.T, a *api, pattern string) string {
	t.Helper()
	filled := strings.ReplaceAll(pattern, "{key}", "reference")
	if strings.Contains(filled, "{id}") {
		var id string
		if err := a.pool.QueryRow(t.Context(),
			`SELECT id FROM platform_tools WHERE subdomain = 'docs'`).Scan(&id); err != nil {
			t.Fatalf("finding a seeded tool: %v", err)
		}
		filled = strings.ReplaceAll(filled, "{id}", id)
	}
	return filled
}

func TestEveryRouteRefusesAPrincipalWithoutThePlatformCapability(t *testing.T) {
	// A token that is entirely valid — right issuer, right audience, not
	// expired — and holds `read`, which is console entry and nothing else.
	// This is the exact shape of the threat: a real session.
	a := serveAs(t, "read")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 — a valid session is not authorisation: %s",
				route.Method, route.Pattern, got.status, got.raw)
		}
	}
}

// The companion. Same routes, same bodies, same fixture — with `platform`.
func TestTheSameRequestsWithTheCapabilitySucceed(t *testing.T) {
	a := serveAs(t, "read", "platform")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
		if got.status != c.want {
			t.Errorf("%s %s with `platform` = %d, want %d — the refusal above proves "+
				"nothing unless this request works: %s",
				route.Method, route.Pattern, got.status, c.want, got.raw)
		}
	}
}

func TestAnUnauthenticatedRequestIs401AndNot403(t *testing.T) {
	// Different questions with different answers: "who are you" and "may you".
	// A caller told 403 would go looking for a missing role when the problem is
	// a missing token.
	a := serve(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/platform/tools", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
}
