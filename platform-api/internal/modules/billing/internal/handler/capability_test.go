package handler_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// routeCase is what a route needs to be exercised: a body where it takes one,
// and the status it answers when every capability IS held.
//
// want is asserted so the refusal test below proves something — a 403 caused
// by a missing route or a mistyped path would satisfy it while proving nothing
// about the gate.
type routeCase struct {
	body string
	want int
}

func caseFor(t *testing.T, r handler.Route) routeCase {
	t.Helper()
	switch r.Method + " " + r.Pattern {
	case "GET /v1/billing/subscriptions":
		return routeCase{want: http.StatusOK}
	case "GET /v1/billing/trials":
		return routeCase{want: http.StatusOK}
	case "POST /v1/billing/tenants/{id}/discount":
		return routeCase{body: validDiscount, want: http.StatusOK}
	case "POST /v1/billing/tenants/{id}/discount/remove":
		return routeCase{body: validDiscount, want: http.StatusOK}
	}
	t.Fatalf("%s %s is registered but has no case here — decide its capability and add it",
		r.Method, r.Pattern)
	return routeCase{}
}

func path(pattern string) string {
	return strings.ReplaceAll(pattern, "{id}", namespacedTenant)
}

func (a *api) exercise(r handler.Route, c routeCase) response {
	a.t.Helper()
	headers := map[string]string{}
	if r.Write {
		headers["Idempotency-Key"] = "k-1"
	}
	return a.do(r.Method, path(r.Pattern), c.body, headers)
}

// Ranges over handler.RouteTable and fails on an entry it has no case for.
// Mirrors audit, tenants, inbox, kpis, entities and tools — but this is the
// first module in the estate whose answer is NOT CapPlatform.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string][]auth.Capability{
		// `billing`, and this module is the first route to use it.
		// platform-auth's capabilities.ts has carried it since the vocabulary
		// was written, marked RESERVED with the note that "the console has no
		// billing surface today (0 of 28 routes)". That reservation ends here.
		//
		// Using `platform` instead — the gate every other Operate read uses —
		// would have been easier and would have made the capability vocabulary
		// decorative on the one surface it was clearly drawn for.
		"GET /v1/billing/subscriptions": {auth.CapBilling},
		"GET /v1/billing/trials":        {auth.CapBilling},
		// The two writes stack `publish-catalog` on top, the way the email
		// templates module stacks `mass-send` for a test send: the surface
		// says where an operator works, the verb says they may do the
		// consequential thing there. Applying a coupon changes a real Stripe
		// subscription, and the console's own shipped mint checks the same
		// pair for the same reason — the half that CREATES the coupon must not
		// be gated more tightly than the half that puts it on live billing.
		"POST /v1/billing/tenants/{id}/discount":        {auth.CapBilling, auth.CapPublishCatalog},
		"POST /v1/billing/tenants/{id}/discount/remove": {auth.CapBilling, auth.CapPublishCatalog},
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capabilities, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capabilities[0] != auth.CapBilling {
			t.Errorf("route %s: surface capability %q; revenue is gated on `billing`", key, capabilities[0])
		}
		if r.Write != (len(capabilities) == 2) {
			t.Errorf("route %s: Write=%v disagrees with the capabilities this test names (%v); "+
				"Write is what mounts the publish-catalog gate", key, r.Write, capabilities)
		}
	}
}

// Companion to the 403 tests: proves every route is REACHED once both
// capabilities are held, so a refusal proves something rather than being
// satisfied by a route that never answers.
func TestEveryRouteIsReachedWhenTheCapabilitiesAreHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		c := caseFor(t, r)
		if got := a.exercise(r, c); got.status != c.want {
			t.Errorf("%s %s with billing+publish-catalog = %d, want %d: %s",
				r.Method, r.Pattern, got.status, c.want, got.raw)
		}
	}
}
