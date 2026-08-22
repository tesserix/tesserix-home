package handler

import "testing"

// Ranges over RouteTable and fails on an entry it has no case for, so a route
// added without a capability decision turns the suite red rather than passing
// untested. Mirrors the tools module's capability_test.
func TestEveryRouteNamesItsCapability(t *testing.T) {
	want := map[string]string{
		"GET /v1/audit": "platform",
	}
	for _, r := range RouteTable {
		key := r.Method + " " + r.Pattern
		capability, ok := want[key]
		if !ok {
			t.Errorf("route %s has no capability case in this test — decide one and add it", key)
			continue
		}
		if capability != "platform" {
			t.Errorf("route %s: capability %q; the estate audit log is platform-gated per console-core routes.ts", key, capability)
		}
	}
}
