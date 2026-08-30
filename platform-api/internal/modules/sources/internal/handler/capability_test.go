package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/sources/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red rather
// than passing untested. Mirrors kpis, koraaimetrics, onboardingfunnel, audit,
// tenants and tools.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		// The shape of the estate's federation configuration is the most
		// platform-operational fact there is, and a caller who may not read
		// any federated surface has no use for the list of products serving
		// them.
		"GET /v1/platform/sources": auth.CapPlatform,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != auth.CapPlatform {
			t.Errorf("route %s: capability %q; this is an Operate read", key, capability)
		}
	}
}

// Companion to the refusal test: proves the route is REACHED once the
// capability is held, so a 403 elsewhere is a real finding rather than being
// satisfied by a route that never answers.
func TestEveryRouteIsReachedWhenTheCapabilityIsHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		if got := a.do(r.Method, r.Pattern); got.status == http.StatusForbidden {
			t.Errorf("%s %s with platform = 403; the gate refused an operator who holds it: %s",
				r.Method, r.Pattern, got.raw)
		}
	}
}
