package handler_test

import (
	"net/http"
	"net/url"
	"testing"
)

// windowRoutes is both routes that take the created_from/created_to pair,
// each with a body its own reader will accept. The defect below is identical
// on the two, and so is the fix, so every case here runs against both.
var windowRoutes = []struct {
	route string
	body  string
}{
	{route, liveFunnel},
	{sessionsRoute, liveSessions},
}

// windowURL builds a request with one window parameter, escaped, so a value
// carrying `+` or a space survives the trip as itself rather than arriving as
// something the assertion would then be measuring instead.
func windowURL(route, param, value string) string {
	return route + "?source=" + productSlug + "&" + param + "=" + url.QueryEscape(value)
}

// malformedWindows is every shape of created_from/created_to that mark8ly's
// parseTime returns ok=false for, and therefore every shape that reaches the
// upstream as NO filter at all.
//
// Verified by running mark8ly's own parseTime (marketplace-api,
// internal/handlers/platformadmin/audit_logs.go): it is
// time.Parse(time.RFC3339, strings.TrimSpace(v)) and nothing else. Each of
// these is dropped there, and each drop widens the window to all time.
var malformedWindows = map[string]string{
	"a bare date":            "2026-08-01",
	"a space-separated time": "2026-08-01 00:00:00",
	"a naive local time":     "2026-08-01T00:00:00",
	"a unix timestamp":       "1754006400",
	"prose":                  "last-tuesday",
	"an impossible month":    "2026-13-01T00:00:00Z",
	"a compact zone offset":  "2026-08-01T00:00:00+0530",
	"a lowercase t and z":    "2026-08-01t00:00:00z",
	"a layout mistake":       "2026-08-01T00:00:00Z07:00",
}

// THE defect, on both routes. mark8ly drops a created_from it cannot parse,
// and a dropped lower bound is not a narrower answer — it is EVERY session
// and EVERY count since the beginning of time, handed to an operator who
// asked for a week. On the funnel route there are not even rows to eyeball:
// the answer is a set of counters, and its window line says "all time"
// truthfully to nobody who was not already suspicious.
//
// Refusing here is the only place that distinction still survives.
func TestAMalformedWindowIsRefusedRatherThanSilentlyWidened(t *testing.T) {
	for _, spec := range windowRoutes {
		for _, param := range []string{"created_from", "created_to"} {
			for name, value := range malformedWindows {
				t.Run(spec.route+" "+param+" "+name, func(t *testing.T) {
					a, seen := recording(t, spec.body)
					got := a.get(windowURL(spec.route, param, value))
					if got.status != http.StatusBadRequest {
						t.Errorf("status = %d, want 400: %s", got.status, got.raw)
					}
					// Not merely refused: never asked. A widened read that
					// happens behind a 400 is still a widened read.
					if *seen != nil {
						t.Errorf("the product was asked anyway: %v", *seen)
					}
					if _, wrote := got.body["data"]; wrote {
						t.Errorf("a refusal wrote a data key: %s", got.raw)
					}
				})
			}
		}
	}
}

// The other half of the same rule: everything parseTime DOES accept is still
// accepted here, and forwarded byte for byte. A stricter console-side format
// would refuse a request the product would have honoured — the same silent
// narrowing, from the opposite direction.
func TestAWindowTheProductWouldHonourIsForwardedVerbatim(t *testing.T) {
	for name, value := range map[string]string{
		"an instant in UTC":      "2026-08-01T00:00:00Z",
		"milliseconds":           "2026-08-01T00:00:00.123Z",
		"nanoseconds":            "2026-08-01T00:00:00.123456789Z",
		"a positive zone offset": "2026-08-01T00:00:00+05:30",
		"a negative zone offset": "2026-08-01T00:00:00-07:00",
		"surrounding whitespace": " 2026-08-01T00:00:00Z ",
	} {
		t.Run(name, func(t *testing.T) {
			for _, spec := range windowRoutes {
				a, seen := recording(t, spec.body)
				got := a.get(windowURL(spec.route, "created_from", value))
				if got.status != http.StatusOK {
					t.Fatalf("%s: status = %d, want 200: %s", spec.route, got.status, got.raw)
				}
				// Verbatim, whitespace included: mark8ly trims it itself, and
				// rewriting it here would make this layer's echo of the
				// effective window a claim it had not verified.
				if seen.Get("created_from") != value {
					t.Errorf("%s: forwarded created_from = %q, want %q",
						spec.route, seen.Get("created_from"), value)
				}
			}
		})
	}
}

// An absent window stays absent. This layer invents no default range, because
// a window the operator did not choose is a different question again — and it
// is the one the product is entitled to answer, not this hop.
func TestAnAbsentWindowIsNotInvented(t *testing.T) {
	for _, spec := range windowRoutes {
		a, seen := recording(t, spec.body)
		if got := a.get(spec.route + "?source=" + productSlug); got.status != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200: %s", spec.route, got.status, got.raw)
		}
		if seen.Has("created_from") || seen.Has("created_to") {
			t.Errorf("%s: a window was invented: %v", spec.route, *seen)
		}
	}
}

// An empty created_from is not a malformed one. mark8ly's parseTime returns
// ok=false for "" as well, but that drop is the ABSENCE of a filter expressed
// as an empty string — the operator asked for no lower bound and got none.
// Nothing is answered differently from what was asked, so there is nothing to
// refuse.
func TestAnEmptyWindowParameterIsNotARefusal(t *testing.T) {
	for _, spec := range windowRoutes {
		a, _ := recording(t, spec.body)
		if got := a.get(windowURL(spec.route, "created_from", "")); got.status != http.StatusOK {
			t.Errorf("%s: status = %d, want 200: %s", spec.route, got.status, got.raw)
		}
	}
}

// The decision that goes with the one above. status is NOT validated, and a
// value this service has never heard of is forwarded rather than refused:
// there is no canonical list of onboarding statuses this deployment can see,
// and inventing one would refuse questions the product would have answered.
//
// It is safe to pass through for a reason the window is not: a mistyped
// status narrows. The filter is applied, to a value nothing matches, and the
// operator gets a visibly empty list — the truthful answer to what they
// actually typed. A mistyped created_from widens, invisibly. Only the second
// needs a 400.
func TestAnUnrecognisedStatusIsForwardedRatherThanRefused(t *testing.T) {
	a, seen := recording(t, liveSessions)
	got := a.get(sessionsRoute + "?source=" + productSlug + "&status=in_pogress")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	if seen.Get("status") != "in_pogress" {
		t.Errorf("forwarded status = %q, want the caller's own spelling", seen.Get("status"))
	}
}
