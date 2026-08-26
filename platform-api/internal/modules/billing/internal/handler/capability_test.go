package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for.
// Mirrors audit, tenants, inbox, kpis, entities and tools — but this is the
// first module in the estate whose answer is NOT CapPlatform.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		// `billing`, and this module is the first route to use it.
		// platform-auth's capabilities.ts has carried it since the vocabulary
		// was written, marked RESERVED with the note that "the console has no
		// billing surface today (0 of 28 routes)". That reservation ends here.
		//
		// Using `platform` instead — the gate every other Operate read uses —
		// would have been easier and would have made the capability vocabulary
		// decorative on the one surface it was clearly drawn for.
		"GET /v1/billing/subscriptions": auth.CapBilling,
		"GET /v1/billing/trials":        auth.CapBilling,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != auth.CapBilling {
			t.Errorf("route %s: capability %q; revenue is gated on `billing`", key, capability)
		}
	}
}

// Companion to the 403 test: proves every route is REACHED once the capability
// is held, so the refusal proves something rather than being satisfied by a
// route that never answers.
func TestEveryRouteIsReachedWhenTheCapabilityIsHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		if got := a.do(r.Method, r.Pattern); got.status == http.StatusForbidden {
			t.Errorf("%s %s with billing = 403; the gate refused an operator who holds it: %s",
				r.Method, r.Pattern, got.raw)
		}
	}
}
