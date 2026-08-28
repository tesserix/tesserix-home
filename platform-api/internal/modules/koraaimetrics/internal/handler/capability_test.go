package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/koraaimetrics/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red
// rather than passing untested. Mirrors kpis, audit, tenants and inbox.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		// Same gate as the other Operate reads. Deliberately NOT `billing`:
		// AI-resolution metrics are an operational view of a product, and
		// `billing` is reserved for the revenue surfaces §8.2 defines.
		"GET /v1/kora/ai-metrics": auth.CapPlatform,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != auth.CapPlatform {
			t.Errorf("route %s: capability %q; koraaimetrics is an Operate read", key, capability)
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
