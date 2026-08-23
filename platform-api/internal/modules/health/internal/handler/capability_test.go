package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

type routeCase struct {
	capability auth.Capability
	want       int
}

// routeCases is one entry per route in handler.RouteTable, keyed by
// "METHOD /pattern" exactly as the table spells it. Both tests range over
// RouteTable and FAIL on an entry with no case here, so a second route cannot
// be served untested.
func routeCases() map[string]routeCase {
	return map[string]routeCase{
		// `read`, NOT `platform`. The header renders on every page for every
		// operator; gating this on `platform` gives a crm-only operator a 403
		// the indicator can only render as "unmeasured" — telling them the
		// estate is unmeasured when the truth is they are not authorised.
		// The same defect (C1) was found and fixed on the tools API.
		"GET /v1/platform/health": {capability: auth.CapRead, want: http.StatusOK},
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

func TestEveryRouteRefusesAPrincipalWithoutItsRequiredCapability(t *testing.T) {
	// A token that is entirely valid and holds `crm` — some OTHER capability,
	// not none: an empty Roles claim fails at the verifier itself (401)
	// before a capability is ever checked, which would prove nothing about
	// the gate this test exists to test.
	a := serveAs(t, okSource, "crm")
	for _, route := range handler.RouteTable {
		caseFor(t, route)
		got := a.get(route.Pattern)
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403: %s", route.Method, route.Pattern, got.status, got.raw)
		}
	}
}

func TestEveryRouteAnswersAPrincipalHoldingItsCapability(t *testing.T) {
	// The companion. A refusal test alone is satisfied by a route that does
	// not exist, because a 403 from a mistyped path looks exactly like a 403
	// from the capability gate.
	a := serveAs(t, okSource, "read")
	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.get(route.Pattern)
		if got.status != c.want {
			t.Errorf("%s %s = %d, want %d: %s",
				route.Method, route.Pattern, got.status, c.want, got.raw)
		}
	}
}
