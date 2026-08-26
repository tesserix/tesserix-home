package handler_test

import (
	"net/http"
	"strings"
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
		// Suspension is reversible and operational, so `platform` alone —
		// the same gate the directory read uses.
		//
		// The IRREVERSIBLE verb is deliberately not in this table, because it
		// is deliberately not in RouteTable: tenant purge belongs behind
		// `platform` AND `hard-delete`, and no route in this service requires
		// a verb capability yet. Making purge the first one is a decision that
		// deserves its own review rather than riding along with a reversible
		// sibling.
		"POST /v1/tenants/{id}/suspend":   auth.CapPlatform,
		"POST /v1/tenants/{id}/unsuspend": auth.CapPlatform,
		// The vocabulary those two writes require, gated the same way. It
		// reads nothing about a tenant and mutates nothing — but it is the
		// menu on a `platform` write, and gating it lower would let an
		// operator who cannot suspend enumerate the reasons one is suspended
		// for, which is a small disclosure with no purpose behind it.
		"GET /v1/tenants/lifecycle/reason-codes": auth.CapPlatform,
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

// Companion to the 403 test: proves every route is REACHED once the capability
// is held, so the refusal proves something rather than being satisfied by a
// route that never answers at all.
//
// "Reached", not "answers 200": the write routes have their own required
// inputs, and a request with none of them is correctly a 400. What matters
// here is that the capability gate let it through to the handler — a 403 would
// mean the route is gated on something the operator does not hold, which is
// the failure this test exists to catch. So 403 is the assertion, and any
// other status passes.
func TestEveryRouteIsReachedWhenTheCapabilityIsHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		path := strings.ReplaceAll(r.Pattern, "{id}", "mark8ly:t1")
		got := a.do(r.Method, path, "", nil)
		if got.status == http.StatusForbidden {
			t.Errorf("%s %s with platform = 403; the capability gate refused an operator who holds it: %s",
				r.Method, path, got.raw)
		}
	}
}
