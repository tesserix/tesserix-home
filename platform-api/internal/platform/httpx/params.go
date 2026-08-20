package httpx

import (
	"net/url"
	"sort"
)

// RejectUnknownParameters refuses a query carrying anything a route does not
// read.
//
// # Why this is worth a 400
//
// It is the read-side equivalent of DisallowUnknownFields, and the argument is
// the same one a strict decode makes: a caller sending `?stge=new` otherwise
// receives the WHOLE collection and a 200. A filter that silently does
// nothing is a broader-result-set failure, indistinguishable from success
// until someone notices the numbers are wrong. Accepting a misspelled
// parameter leaves that hole open for every route that calls this.
//
// The accepted list is returned in the message, sorted, because the person
// reading it is looking at a URL that does not work and needs to know what to
// write instead.
func RejectUnknownParameters(query url.Values, allowed []string) error {
	known := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		known[name] = struct{}{}
	}
	var unknown []string
	for name := range query {
		if _, ok := known[name]; !ok {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	// Sorted so the response is the same on every run: Go randomises map
	// iteration, and a golden file asserting on this would otherwise flake.
	sort.Strings(unknown)
	accepted := append([]string{}, allowed...)
	sort.Strings(accepted)
	// Each unknown parameter keyed to the value it carried: a `details` key
	// is a request parameter and its value is the offending input. It
	// replaces a `unknown: [...]` list, which named the parameters but threw
	// away what they said — a caller who sent `?stge=new` wants to see `new`
	// beside the misspelling. `accepted` is the same array it always was.
	details := map[string]any{"accepted": accepted}
	for _, name := range unknown {
		details[name] = query.Get(name)
	}
	return BadRequest("the request carries query parameters this endpoint does not read").
		WithDetails(details)
}
