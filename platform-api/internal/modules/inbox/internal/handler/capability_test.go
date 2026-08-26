package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/inbox/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red rather
// than passing untested. Mirrors the audit, tenants and tools modules.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		// The inbox sits in the platform rail's Operate group beside the audit
		// log and the tenant directory, and is gated the same way.
		//
		// Deliberately NOT a verb capability: nothing here acts on anything.
		// §8.3's `POST /admin/inbox/{id}/actions/{actionId}` does not exist on
		// any product yet, and when it does it will be a separate route with
		// its own decision — an action that changes a product's state is not
		// covered by the capability that lets someone read the queue.
		"GET /v1/inbox": auth.CapPlatform,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != auth.CapPlatform {
			t.Errorf("route %s: capability %q; the inbox is an Operate surface", key, capability)
		}
	}
}

// Companion to the refusal test: proves the route is REACHED once the
// capability is held, so a 403 elsewhere would be a real finding rather than
// being satisfied by a route that never answers at all.
func TestEveryRouteIsReachedWhenTheCapabilityIsHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		if got := a.do(r.Method, r.Pattern); got.status == http.StatusForbidden {
			t.Errorf("%s %s with platform = 403; the gate refused an operator who holds it: %s",
				r.Method, r.Pattern, got.raw)
		}
	}
}
