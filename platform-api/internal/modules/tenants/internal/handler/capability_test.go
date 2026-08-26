package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red rather
// than passing untested. Mirrors the audit and tools modules.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		"GET /v1/tenants": auth.CapPlatform,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != auth.CapPlatform {
			t.Errorf("route %s: capability %q; tenants sits in the platform rail's Operate group", key, capability)
		}
	}
}

// Companion to the 403 test: proves every route answers once the capability IS
// held, so the refusal proves something rather than being satisfied by a route
// that never answers at all.
func TestEveryRouteAnswersWhenTheCapabilityIsHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		got := a.do(r.Method, r.Pattern, "", nil)
		if got.status != http.StatusOK {
			t.Errorf("%s %s with platform = %d, want 200: %s", r.Method, r.Pattern, got.status, got.raw)
		}
	}
}
