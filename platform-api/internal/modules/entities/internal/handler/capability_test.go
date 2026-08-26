package handler_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/entities/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red rather
// than passing untested. Mirrors audit, tenants, inbox, kpis and tools.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		// Same gate the tenant directory uses, and it reads §3.4's `tenants`
		// type through the same contract endpoint — so a different capability
		// here would mean one §3.4 type was reachable by operators another was
		// not, for no reason either surface could explain.
		"GET /v1/entities/{type}": auth.CapPlatform,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != auth.CapPlatform {
			t.Errorf("route %s: capability %q; §3.4 reads are an Operate surface", key, capability)
		}
	}
}

// Companion to the refusal test: proves the route is REACHED once the
// capability is held, so a 403 elsewhere is a real finding rather than being
// satisfied by a route that never answers.
func TestEveryRouteIsReachedWhenTheCapabilityIsHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		path := strings.ReplaceAll(r.Pattern, "{type}", "foods") + "?source=" + productSlug
		if got := a.do(r.Method, path); got.status == http.StatusForbidden {
			t.Errorf("%s %s with platform = 403; the gate refused an operator who holds it: %s",
				r.Method, path, got.raw)
		}
	}
}
