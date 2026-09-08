package handler_test

import (
	"net/http"
	"slices"
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
	case "GET /v1/billing/entitlements":
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

// gate is what one route requires, named here independently of RouteTable so
// that changing the table without changing this test fails.
//
// Two fields rather than one list, because the two mean opposite things and a
// single list cannot hold both. `operator` is an AND — every capability in it
// is needed. `machine` is an OR — one capability that admits the route INSTEAD
// of the surface. Writing `read-entitlements` into `operator` would say the
// route requires `billing` AND `read-entitlements`, which is the reverse of
// what it does and would leave every existing assertion below still passing.
type gate struct {
	operator []auth.Capability
	machine  auth.Capability
}

// Ranges over handler.RouteTable and fails on an entry it has no case for.
// Mirrors audit, tenants, inbox, kpis, entities and tools — but this is the
// first module in the estate whose answer is NOT CapPlatform.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]gate{
		// `billing`, and this module is the first route to use it.
		// platform-auth's capabilities.ts has carried it since the vocabulary
		// was written, marked RESERVED with the note that "the console has no
		// billing surface today (0 of 28 routes)". That reservation ends here.
		//
		// Using `platform` instead — the gate every other Operate read uses —
		// would have been easier and would have made the capability vocabulary
		// decorative on the one surface it was clearly drawn for.
		"GET /v1/billing/subscriptions": {operator: []auth.Capability{auth.CapBilling}},
		"GET /v1/billing/trials":        {operator: []auth.Capability{auth.CapBilling}},
		// The compiled plan-feature matrix is a read of the estate's revenue
		// terms, so an OPERATOR takes the surface capability and nothing more —
		// the same gate its two siblings take, read off them rather than chosen.
		//
		// It is also the one route on this module a MACHINE reaches (#618),
		// through a capability of its own rather than through `billing`.
		// Deliberately not extended to the two siblings: they have no machine
		// caller, and capabilities are estate-wide, so granting one there
		// would hand an unattended identity every product's revenue.
		"GET /v1/billing/entitlements": {
			operator: []auth.Capability{auth.CapBilling},
			machine:  auth.CapReadEntitlements,
		},
		// The two writes stack `publish-catalog` on top, the way the email
		// templates module stacks `mass-send` for a test send: the surface
		// says where an operator works, the verb says they may do the
		// consequential thing there. Applying a coupon changes a real Stripe
		// subscription, and the console's own shipped mint checks the same
		// pair for the same reason — the half that CREATES the coupon must not
		// be gated more tightly than the half that puts it on live billing.
		"POST /v1/billing/tenants/{id}/discount": {
			operator: []auth.Capability{auth.CapBilling, auth.CapPublishCatalog},
		},
		"POST /v1/billing/tenants/{id}/discount/remove": {
			operator: []auth.Capability{auth.CapBilling, auth.CapPublishCatalog},
		},
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		g, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if g.operator[0] != auth.CapBilling {
			t.Errorf("route %s: surface capability %q; revenue is gated on `billing`", key, g.operator[0])
		}
		if r.Write != (len(g.operator) == 2) {
			t.Errorf("route %s: Write=%v disagrees with the capabilities this test names (%v); "+
				"Write is what mounts the publish-catalog gate", key, r.Write, g.operator)
		}
		if r.MachineCapability != g.machine {
			t.Errorf("route %s: table says machine capability %q, this test says %q",
				key, r.MachineCapability, g.machine)
		}
		if g.machine == "" {
			continue
		}
		// A write must never offer a machine alternative. Reading what the
		// estate bills is one thing; letting an unattended identity change a
		// merchant's live billing is another, and the OR shape would make
		// `publish-catalog` optional rather than additional.
		if r.Write {
			t.Errorf("route %s: a write must not name a machine alternative — that "+
				"would let a machine past the publish-catalog gate entirely", key)
		}
		// It must come from the machine bucket. Surfaces and verbs describe an
		// operator's console session (capabilities.go), so admitting a route
		// on one of those "as a machine" would misstate what the holder is.
		if !slices.Contains(auth.Machines, g.machine) {
			t.Errorf("route %s: %q is not in auth.Machines — a machine alternative "+
				"must be a machine capability, not an operator surface or verb",
				key, g.machine)
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

// --- the machine alternative (#618) -----------------------------------------

// The point of the change: a service principal holding ONLY
// `read-entitlements` reads the matrix, without holding `billing`.
//
// Asserted as a 200 carrying the matrix rather than merely "not 403", because
// a gate that admits the caller and then fails on something else has not
// actually made parity runnable.
func TestAMachineHoldingOnlyReadEntitlementsReadsTheMatrix(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "read-entitlements")
	got := a.get("/v1/billing/entitlements")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	rows, _ := got.data(t)["data"].([]any)
	if len(rows) != 1 {
		t.Errorf("data = %v, want the product's matrix — an admitted caller that "+
			"reads nothing has not made parity runnable", got.raw)
	}
}

// The operator path is untouched. `billing` alone still reads the matrix, and
// it must keep doing so: the console's own entitlements surface depends on it.
func TestAnOperatorHoldingOnlyBillingStillReadsTheMatrix(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "billing")
	if got := a.get("/v1/billing/entitlements"); got.status != http.StatusOK {
		t.Errorf("status = %d, want 200 — widening a route must not narrow it: %s",
			got.status, got.raw)
	}
}

// The failure mode this change is most likely to have: "accepts either"
// becoming "accepts everyone". A valid session holding NEITHER capability is
// still refused, and the refusal is a 403 rather than a 401 — the caller's
// credential is fine, the grant is what is missing, and collapsing the two
// tells them to reissue a token that would fail identically.
func TestTheEntitlementsRouteStillRefusesAPrincipalHoldingNeither(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "read")
	got := a.get("/v1/billing/entitlements")
	if got.status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 — an either/or gate must not admit everyone: %s",
			got.status, got.raw)
	}
	details, _ := got.body["error"].(map[string]any)
	if details["code"] != "FORBIDDEN" {
		t.Errorf("error code = %v, want FORBIDDEN — 401 says reissue your credential, "+
			"403 says ask for the grant, and they are different instructions", details["code"])
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a refused read still reached the product: %s %s", c.method, c.url)
	}
}

// The narrowness that matters as much as the widening. `read-entitlements`
// reaches the matrix and NOTHING else on this module — not the two sibling
// reads, not the discount writes. Ranges the table so a route added later is
// refused by default rather than silently inheriting the machine alternative.
func TestTheMachineCapabilityReachesOnlyTheRouteThatNamesIt(t *testing.T) {
	a := serveAs(t, []string{productSlug}, "read-entitlements")
	for _, r := range handler.RouteTable {
		c := caseFor(t, r)
		got := a.exercise(r, c)
		want := http.StatusForbidden
		if r.MachineCapability == auth.CapReadEntitlements {
			want = c.want
		}
		if got.status != want {
			t.Errorf("%s %s with read-entitlements = %d, want %d: %s",
				r.Method, r.Pattern, got.status, want, got.raw)
		}
	}
}
