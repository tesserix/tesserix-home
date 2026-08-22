package handler_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
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
	// capability is the capability THIS route requires — `read` for the two
	// GETs, `platform` for the six writes. Named per route rather than
	// assumed, so a route that starts requiring a third capability someday
	// has to say so here rather than being tested against the wrong
	// principal.
	capability auth.Capability
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
		"GET /v1/platform/tools":       {capability: auth.CapRead, want: http.StatusOK},
		"GET /v1/platform/tool-groups": {capability: auth.CapRead, want: http.StatusOK},
		"POST /v1/platform/tools": {
			capability: auth.CapPlatform,
			body:       `{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`,
			want:       http.StatusCreated,
		},
		"PATCH /v1/platform/tools/{id}": {
			capability: auth.CapPlatform,
			body:       `{"purpose":"Changed."}`,
			want:       http.StatusOK,
		},
		"DELETE /v1/platform/tools/{id}": {capability: auth.CapPlatform, want: http.StatusOK},
		"POST /v1/platform/tool-groups": {
			capability: auth.CapPlatform,
			body:       `{"key":"security","label":"Security"}`,
			want:       http.StatusCreated,
		},
		"PATCH /v1/platform/tool-groups/{key}": {
			capability: auth.CapPlatform,
			body:       `{"label":"Changed"}`,
			want:       http.StatusOK,
		},
		// `reference` is the group `path` fills in, and it has three tools —
		// so DELETE is refused by the foreign key. The capability test asks
		// only whether the gate let the request through, and 409 proves it
		// did as well as 200 would.
		"DELETE /v1/platform/tool-groups/{key}": {capability: auth.CapPlatform, want: http.StatusConflict},
	}
}

func caseFor(t *testing.T, route handler.Route) routeCase {
	t.Helper()
	key := route.Method + " " + route.Pattern
	c, ok := routeCases()[key]
	if !ok {
		t.Fatalf("%s is registered but has no capability case; add it to routeCases so "+
			"the route is proved to refuse a principal without its required capability AND "+
			"to answer one that holds it", key)
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

func TestEveryRouteRefusesAPrincipalWithoutItsRequiredCapability(t *testing.T) {
	// Two subtests, matched to the two gates this module now has, each its
	// own api instance — testdb.New names a database from t.Name(), so two
	// live instances against ONE t would be two pools racing to drop and
	// recreate the same database. Running each as a subtest gives both a
	// distinct name and keeps the loop over RouteTable fail-closed in each:
	// caseFor still fails the suite on a route with no case, whichever half
	// it falls in.
	t.Run("read routes refuse a principal holding neither read nor platform", func(t *testing.T) {
		// A token that is entirely valid and holds `crm` — some OTHER
		// capability, not none at all: an empty Roles claim fails at the
		// verifier itself (ErrNoRoles, 401) before a capability is ever
		// checked, which would prove nothing about the gate this test exists
		// to test. Holding `crm` alone is neither `read` nor `platform`, so
		// it is the real "session that lacks what this route wants."
		a := serveAs(t, "crm")
		for _, route := range handler.RouteTable {
			c := caseFor(t, route)
			if c.capability != auth.CapRead {
				continue
			}
			got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
			if got.status != http.StatusForbidden {
				t.Errorf("%s %s = %d, want 403 — a valid session without `read` is not "+
					"authorisation: %s", route.Method, route.Pattern, got.status, got.raw)
			}
		}
	})

	t.Run("write routes refuse a read-only principal", func(t *testing.T) {
		// A token that is entirely valid — right issuer, right audience, not
		// expired — and holds `read`, which is console entry and nothing
		// else. This is the exact shape of the threat: a real session.
		a := serveAs(t, "read")
		for _, route := range handler.RouteTable {
			c := caseFor(t, route)
			if c.capability != auth.CapPlatform {
				continue
			}
			got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
			if got.status != http.StatusForbidden {
				t.Errorf("%s %s = %d, want 403 — a valid session without `platform` is not "+
					"authorisation: %s", route.Method, route.Pattern, got.status, got.raw)
			}
		}
	})
}

// The companion. Same routes, same bodies, same fixture — with a principal
// that holds BOTH capabilities this module gates on, `read` and `platform`,
// so one loop proves every route answers once it is granted what it asks
// for.
func TestTheSameRequestsWithTheRequiredCapabilitySucceed(t *testing.T) {
	a := serveAs(t, "read", "platform")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
		if got.status != c.want {
			t.Errorf("%s %s with `%s` = %d, want %d — the refusal above proves "+
				"nothing unless this request works: %s",
				route.Method, route.Pattern, c.capability, got.status, c.want, got.raw)
		}
	}
}

// The exact operator C1 harmed: read+crm+support but never `platform`. Before
// the fix this got 403 on the GET too, and the console's loader mistook the
// permanent refusal for a transient outage. It must be able to list the
// directory, and it must still be refused a write.
func TestAReadOnlyPrincipalCanListToolsButCannotCreateOne(t *testing.T) {
	a := serveAs(t, "read")

	list := a.get("/v1/platform/tools")
	if list.status != http.StatusOK {
		t.Fatalf("GET /v1/platform/tools with `read` = %d, want 200: %s", list.status, list.raw)
	}

	create := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`, nil)
	if create.status != http.StatusForbidden {
		t.Errorf("POST /v1/platform/tools with `read` (no `platform`) = %d, want 403: %s",
			create.status, create.raw)
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
