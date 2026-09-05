package handler_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// routeCase is what a route needs to be exercised: a body where it takes one,
// and the capabilities it must hold.
type routeCase struct {
	body string
	// want is the status the route answers when every capability IS held. It
	// is asserted so the refusal tests below prove something — a 403 caused by
	// a missing route or a mistyped path would satisfy them while proving
	// nothing about the gate.
	want int
}

func caseFor(t *testing.T, r handler.Route) routeCase {
	t.Helper()
	switch r.Method + " " + r.Pattern {
	case "GET /v1/email-templates":
		return routeCase{want: http.StatusOK}
	case "GET /v1/email-templates/{id}":
		return routeCase{want: http.StatusOK}
	case "PUT /v1/email-templates/{id}":
		return routeCase{body: validSave, want: http.StatusOK}
	case "POST /v1/email-templates/{id}/test-send":
		return routeCase{body: `{"to":"ops@tesserix.app"}`, want: http.StatusOK}
	}
	t.Fatalf("%s %s is registered but has no case here — decide its capability and add it",
		r.Method, r.Pattern)
	return routeCase{}
}

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red rather
// than passing untested. Mirrors the inbox, tenants and tools modules.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string][]auth.Capability{
		// `platform`, matching every other `mark8ly.*` route and what
		// packages/console-core/src/routes.ts declares for
		// `mark8ly.emailTemplates`: an estate operator reading and writing one
		// product's records.
		"GET /v1/email-templates":      {auth.CapPlatform},
		"GET /v1/email-templates/{id}": {auth.CapPlatform},
		// The WRITE is `platform` alone, deliberately. Authoring copy is a
		// surface concern; the irrevocable act on this surface is the send,
		// not the save — a saved draft does not even reach a merchant, and a
		// published one only changes what a later, product-triggered send
		// says.
		"PUT /v1/email-templates/{id}": {auth.CapPlatform},
		// The send is the exception routes.ts names in the same breath as the
		// surface: "authoring a template is not sending one, so the test-send
		// ACTION must assert `mass-send` itself rather than the whole editor
		// being gated on it". Both, stacked — the surface says where an
		// operator works, the verb says they may email someone from there.
		"POST /v1/email-templates/{id}/test-send": {auth.CapPlatform, auth.CapMassSend},
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		capabilities, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if r.Send != (len(capabilities) == 2) {
			t.Errorf("route %s: Send=%v disagrees with the capabilities this test names (%v); "+
				"Send is what mounts the mass-send gate", key, r.Send, capabilities)
		}
	}
}

func path(pattern string) string {
	return strings.ReplaceAll(pattern, "{id}", invoiceID)
}

func (a *api) exercise(r handler.Route, c routeCase) response {
	a.t.Helper()
	headers := map[string]string{}
	if r.Write {
		headers["Idempotency-Key"] = "k-1"
	}
	return a.do(r.Method, path(r.Pattern), c.body, headers)
}

// The API is the authorisation boundary. #244 put surface refusal in the
// console's middleware; if this service authorised only "is this a valid
// token", anything holding a session could call the module directly and every
// console restriction would be decoration.
func TestEveryRouteRefusesAPrincipalWithoutTheSurfaceCapability(t *testing.T) {
	// A token that is entirely valid — right issuer, right audience, not
	// expired — holding `read`, which #261 reduced to console entry and
	// nothing else. This is the exact shape of the threat: a real session.
	a := serveWith(t, http.HandlerFunc(product), []string{productSlug}, "read")

	for _, r := range handler.RouteTable {
		got := a.exercise(r, caseFor(t, r))
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 — a valid session is not authorisation: %s",
				r.Method, r.Pattern, got.status, got.raw)
		}
	}

	// The half a status code cannot show: nothing was forwarded. A write
	// refused AFTER it reached the product has already happened.
	if c, called := a.lastCall(); called {
		t.Errorf("a refused request still reached the product: %s %s", c.method, c.url)
	}
}

// The companion, which #269 requires: the same requests with the capabilities
// held. Only the pair says "these routes exist, they work, and the ONLY thing
// standing between the principal and them was the capability".
func TestTheSameRequestsWithTheCapabilitiesSucceed(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		c := caseFor(t, r)
		got := a.exercise(r, c)
		if got.status != c.want {
			t.Errorf("%s %s with platform+mass-send = %d, want %d — the refusal above proves "+
				"nothing unless this request works: %s", r.Method, r.Pattern, got.status, c.want, got.raw)
		}
	}
}

// The decision this module exists to get right, asserted on its own: an
// operator who may AUTHOR templates has not thereby been granted permission to
// send one. `platform` opens the editor; the send needs `mass-send` as well.
func TestTheTestSendIsRefusedToAnOperatorWhoMayOnlyAuthor(t *testing.T) {
	a := serveWith(t, http.HandlerFunc(product), []string{productSlug}, "platform")

	// The editor is open to them...
	if got := a.get("/v1/email-templates/" + invoiceID); got.status != http.StatusOK {
		t.Fatalf("read with `platform` = %d, want 200: %s", got.status, got.raw)
	}
	if got := a.put("/v1/email-templates/"+invoiceID, validSave); got.status != http.StatusOK {
		t.Fatalf("save with `platform` = %d, want 200: %s", got.status, got.raw)
	}

	// ...and the send is not.
	got := a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`)
	if got.status != http.StatusForbidden {
		t.Fatalf("test send with `platform` alone = %d, want 403 — authoring a template is not "+
			"sending one: %s", got.status, got.raw)
	}
}

// And the mirror image, so the test above cannot pass for the wrong reason:
// `mass-send` without the surface is not a way in either.
func TestTheTestSendIsRefusedToAPrincipalHoldingOnlyTheVerb(t *testing.T) {
	a := serveWith(t, http.HandlerFunc(product), []string{productSlug}, "mass-send")
	got := a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`)
	if got.status != http.StatusForbidden {
		t.Fatalf("test send with `mass-send` alone = %d, want 403 — the verb means 'may do the "+
			"irrevocable thing WHERE they work', not everywhere: %s", got.status, got.raw)
	}
}

func TestAnUnauthenticatedRequestIs401AndNot403(t *testing.T) {
	a := serve(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/email-templates", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 — no token is not a capability problem: %s",
			rec.Code, rec.Body.String())
	}
}
