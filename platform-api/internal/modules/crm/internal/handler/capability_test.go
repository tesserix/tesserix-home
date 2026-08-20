package handler_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/handler"
)

// The two tests §9 and #269 require, and the enumeration that keeps them
// honest.
//
// They are a PAIR and neither is worth anything alone. The refusal test on its
// own is satisfied by a route that does not exist — a 403 from a mistyped path
// or a missing fixture looks exactly like a 403 from the capability gate — so
// the companion sends the SAME requests with the capability present and
// insists they succeed.

// routeCase is the request to send for one route, and what a principal WITH
// the capability must get back.
type routeCase struct {
	// body is empty for a read.
	body string
	// want is the status the same request produces once the capability is
	// there. Named per route rather than assumed to be 200, so a route that
	// answers 201 or 204 later does not have to weaken the assertion to
	// "anything but 403" — which would let a 500 pass for a success.
	want int
}

// routeCases is one entry per route in handler.RouteTable, keyed by
// "METHOD /pattern" exactly as the table spells it.
//
// This map is the fail-closed half. Both tests below range over
// handler.RouteTable — the list registration itself reads — and FAIL on an
// entry that has no case here. So a fourth route cannot be added without
// either being covered or turning this package red; there is no third outcome
// where it is served and silently untested. A test that had instead hardcoded
// today's three paths would still pass, having quietly stopped covering the
// module.
func routeCases() map[string]routeCase {
	return map[string]routeCase{
		"GET /v1/crm/queues/due":      {want: http.StatusOK},
		"GET /v1/crm/queues/drifting": {want: http.StatusOK},
		"PUT /v1/crm/opportunities/{id}/next-action": {
			body: `{"at":"2026-09-01T09:00:00Z","note":"send the quote"}`,
			want: http.StatusOK,
		},
	}
}

// caseFor looks up a route's request, failing when there is none.
func caseFor(t *testing.T, route handler.Route) routeCase {
	t.Helper()
	key := route.Method + " " + route.Pattern
	c, ok := routeCases()[key]
	if !ok {
		t.Fatalf("%s is registered but has no capability case; "+
			"add it to routeCases so the route is proved to refuse a principal without `crm` "+
			"AND to answer one that holds it", key)
	}
	return c
}

// path fills a route's pattern in. `{id}` is the only path value the module
// has, and a real one is used rather than a plausible-looking string: a 404
// from a nonexistent opportunity would mask the very difference the companion
// test exists to show.
func path(pattern, id string) string {
	return strings.ReplaceAll(pattern, "{id}", id)
}

func TestEveryRouteRefusesAPrincipalWithoutTheSurfaceCapability(t *testing.T) {
	// A token that is entirely valid — right issuer, right audience, not
	// expired — and holds `read`, which #261 reduced to console entry and
	// nothing else. This is the exact shape of the threat: a real session.
	//
	// The API is the authorisation boundary. #244 put surface refusal in the
	// console's middleware; if this service authorised only "is this a valid
	// token", anything holding a session could call the module directly and
	// every console restriction would be decoration.
	a, id := writeWorldAs(t, "read")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(route.Pattern, id), c.body, nil)
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 — a valid session is not authorisation: %s",
				route.Method, route.Pattern, got.status, got.raw)
		}
	}

	// Nothing was written, which is the half a status code cannot show: the
	// write route must be refused BEFORE it reaches the database, not after.
	if rows := a.auditRows(); len(rows) != 0 {
		t.Errorf("refused requests left %d audit rows: %+v", len(rows), rows)
	}
}

// The companion. Same routes, same bodies, same fixture — with `crm`.
//
// #269 requires this because a 403 caused by a missing route, a mistyped path
// or an absent opportunity would satisfy the test above while proving nothing
// about the capability gate. Only the pair says "these routes exist, they
// work, and the ONLY thing standing between the principal and them was the
// capability".
func TestTheSameRequestsWithTheCapabilitySucceed(t *testing.T) {
	a, id := writeWorldAs(t, "read", "crm")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(route.Pattern, id), c.body, nil)
		if got.status != c.want {
			t.Errorf("%s %s with `crm` = %d, want %d — the refusal above proves nothing "+
				"unless this request works: %s",
				route.Method, route.Pattern, got.status, c.want, got.raw)
		}
	}
}

// The write's gate is the SURFACE and no verb, and that is a finding rather
// than an oversight — console-core's routes.ts declares `capability: "crm"`
// and nothing else on all four CRM surfaces, and the console's own
// scheduleNextAction asserts exactly that. Asserted here so that the day a
// `crm-write` verb is invented in capabilities.ts and Zitadel, this test is
// what says the API has not been told yet.
func TestTheWriteGatesOnTheSurfaceAloneToday(t *testing.T) {
	a, id := writeWorldAs(t, "read", "crm")

	got := a.setNextAction(id, `{"at":"2026-09-01T09:00:00Z"}`, "")

	if got.status != http.StatusOK {
		t.Errorf("the write with `crm` alone = %d, want 200 — if a verb was added to the gate, "+
			"it must exist in the vocabulary and in Zitadel first: %s", got.status, got.raw)
	}
}

func TestAnUnauthenticatedRequestIs401AndNot403(t *testing.T) {
	// Different questions with different answers: "who are you" and "may you".
	// A caller told 403 would go looking for a missing role when the problem
	// is a missing token.
	a := serve(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/crm/queues/due", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
}
