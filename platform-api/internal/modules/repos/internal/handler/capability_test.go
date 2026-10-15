package handler_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Ranges over handler.RouteTable and fails on an entry it has no case for, so
// a route added later without a capability decision turns the suite red rather
// than passing untested.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]auth.Capability{
		"GET /v1/repos": "",
		// Publishing a repository publishes its history; hiding one drops its
		// branch protection on GitHub Free; archiving freezes it. None of that
		// was granted by holding `platform`.
		"POST /v1/repos/visibility": auth.CapRepoAdmin,
		"POST /v1/repos/archive":    auth.CapRepoAdmin,
	}
	for _, r := range handler.RouteTable {
		key := r.Method + " " + r.Pattern
		verb, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if r.Verb != verb {
			t.Errorf("route %s: verb %q, want %q", key, r.Verb, verb)
		}
	}
}

func requestFor(r handler.Route) (string, string) {
	if r.Method == http.MethodGet {
		return r.Pattern, ""
	}
	return r.Pattern, `{"repos":["web"],"visibility":"public","archived":true}`
}

// `platform` alone reads but cannot write.
func TestAWriteRefusesAnOperatorWithoutRepoAdmin(t *testing.T) {
	a := serveWith(t, options{roles: []string{"platform"}, configured: true})
	for _, r := range handler.RouteTable {
		path, body := requestFor(r)
		got := a.do(r.Method, path, body)
		if r.Verb != "" && got.status != http.StatusForbidden {
			t.Errorf("%s %s with platform only = %d, want 403", r.Method, path, got.status)
		}
		if r.Verb == "" && got.status == http.StatusForbidden {
			t.Errorf("%s %s with platform = 403; a read needs nothing more", r.Method, path)
		}
	}
	if len(a.gh.patches) != 0 {
		t.Errorf("GitHub was patched by a refused request: %v", a.gh.patches)
	}
}

// `repo-admin` without the surface is refused too: verbs layer on surfaces,
// they do not replace them.
func TestEveryRouteRefusesAPrincipalWithoutThePlatformSurface(t *testing.T) {
	a := serveWith(t, options{roles: []string{"repo-admin"}, configured: true})
	for _, r := range handler.RouteTable {
		path, body := requestFor(r)
		if got := a.do(r.Method, path, body); got.status != http.StatusForbidden {
			t.Errorf("%s %s with repo-admin only = %d, want 403", r.Method, path, got.status)
		}
	}
}

// Companion to the refusals: every route is REACHED when both are held, so a
// 403 above proves the gate rather than a missing route. Bodies here are
// deliberately invalid for the archive route (both fields), so "reached" means
// "not 403", not "200".
func TestEveryRouteIsReachedWhenTheCapabilitiesAreHeld(t *testing.T) {
	a := serve(t)
	for _, r := range handler.RouteTable {
		path, body := requestFor(r)
		if got := a.do(r.Method, path, body); got.status == http.StatusForbidden {
			t.Errorf("%s %s with platform and repo-admin = 403: %s", r.Method, path, got.raw)
		}
	}
}
