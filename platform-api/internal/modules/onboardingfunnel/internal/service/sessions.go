package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// sessionsPath is mark8ly's own admin route, mounted by the same handler and
// behind the same `deps.OnboardingFunnel != nil` as the funnel. Which is why
// this read is scoped by the same SlugsImplementing("onboarding") declaration:
// a product declaring `onboarding` declares both, and there is no third state
// where one is mounted and the other is not.
const sessionsPath = "/admin/onboarding/sessions"

// ErrNoSessionList is the product answering 404 — the route is not mounted.
// The mirror of ErrNoFunnel, kept separate from ErrNotImplemented for the same
// reason: "not mounted" and "declined" are different debugging stories.
//
// Worth knowing while reading it: mark8ly's handler explicitly never 404s
// EITHER of these endpoints, so reaching this means the routes are absent
// entirely — the over-declaration registry.go warns about.
var ErrNoSessionList = errors.New("onboardingfunnel: the product does not mount a session list")

// ErrSessionsUnreadable is a 200 whose body is not a session page.
//
// Separate from ErrUnreadable because the two guard OPPOSITE shapes and must
// not be confused when someone edits one of them. The funnel's rule is that an
// empty object is an error — `{}` reads as every stage being zero. This one's
// rule is that an empty ARRAY is a success — nobody started onboarding in the
// window is a measurement — while a missing, null or non-array `data` is the
// error, because each of those decodes one layer down as "no sessions".
//
// The invariant underneath is the same one #404's second rule states, and it
// is the reason this sentinel exists rather than a bare error: an empty
// session list and an unreachable product are different answers, and mark8ly
// says so itself — its respondErr maps ErrUnavailable to 503, "never an empty
// 200", because "a console operator shown 'no activity' would believe the
// first".
var ErrSessionsUnreadable = errors.New("onboardingfunnel: the session list could not be read")

// Page is the upstream's pagination block, carried back beside the rows.
//
// This is NOT a crack in the forward-verbatim rule. The rule is about the
// product's own vocabulary — what a session IS, which fields describe it — and
// nothing here names a session field. Pagination is this service's own
// envelope concern: httpx.Meta is the shape a platform-api listing reports it
// in, and something has to carry the numbers from mark8ly's block into it.
// The rows themselves never pass through a Go struct.
type Page struct {
	// Total is every session matching the filter, ignoring the page limit.
	// Required — see sessionsEnvelope.
	Total int64
	// Limit is the page size mark8ly actually applied, which is not always the
	// one asked for. Echoed to the caller through httpx.Meta.Limit so a client
	// can see its request was narrowed rather than inferring it from a short
	// page.
	Limit int
	// Number is the page mark8ly reported serving. Carried for completeness of
	// the upstream's own answer; httpx.Meta has no offset field to put it in,
	// because this service's listings are cursor-shaped.
	Number int
}

// sessionsEnvelope is the envelope's own keys and nothing beneath them.
//
// Data stays json.RawMessage: decoding it into anything with named fields
// would be the second vocabulary this module exists to avoid, and the cost is
// concrete rather than theoretical — mark8ly's internal Session type carries
// `email_verified_at` and its wire row deliberately does not, so a struct
// written from the Go type would have invented a field that never arrives, and
// one written from the wire would drop the next field mark8ly adds.
//
// Pagination is a POINTER so an absent block is distinguishable from a present
// one full of zeroes. Total inside it is a pointer for the same reason: an
// absent total collapses "137 sessions match, you are looking at 50" into
// "these are all of them", which is how an operator working a queue stops
// early believing they are done. Same argument as the funnel's medianKey
// presence check, one envelope up.
type sessionsEnvelope struct {
	Data       json.RawMessage `json:"data"`
	Pagination *struct {
		Page  int    `json:"page"`
		Limit int    `json:"limit"`
		Total *int64 `json:"total"`
	} `json:"pagination"`
}

// ListSessions fetches one page of one product's onboarding sessions and
// returns the rows unparsed.
//
// # PII discipline
//
// Every row carries a merchant's email address. Nothing in this function puts
// the response body into an error or a log line, and that is a rule rather
// than an accident of the current code: the body is the one value here that is
// certain to contain PII, so it may reach exactly one place — the caller's
// return value, on the success path.
//
// The failure paths are safe by construction rather than by redaction.
// federation's own errors never carry a body (statusError holds a slug, a
// status and the §4.4 code, deliberately), and the errors below interpolate
// only the source slug. There is no truncated-body-in-the-message anywhere on
// this path, and sessions_test.go fails if one appears.
//
// Note what is NOT a PII risk here, so nobody adds redaction that is not
// needed: the query. mark8ly's sessions filters are status, a window,
// abandoned, page and limit — none of them is an identifier of a person — so
// logging or echoing the query is safe. If a filter by email is ever added
// upstream, that stops being true and this comment is the place it was said.
//
// # There is no fan-out, for the same reason Read has none
//
// A merged queue across products needs a third vocabulary that is neither
// product's, and with one implementer there is no evidence about what it
// should be.
//
// query is forwarded exactly as received; the handler has already narrowed it
// to the parameters mark8ly reads and clamped the ones that need clamping. It
// is not reinterpreted here — the pagination this returns is mark8ly's echo of
// what it actually applied, and that echo is only meaningful if this layer
// asked for what the handler decided.
func (s *Service) ListSessions(
	ctx context.Context, op federation.Operator, source string, query url.Values,
) (json.RawMessage, Page, error) {
	if len(s.slugs) == 0 {
		return nil, Page{}, ErrNoProducts
	}
	if !contains(s.slugs, source) {
		return nil, Page{}, fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}

	path := sessionsPath
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}

	body, err := s.fed.Get(ctx, source, path, op)
	if err != nil {
		if status, ok := federation.StatusOf(err); ok {
			switch status {
			case http.StatusNotFound:
				return nil, Page{}, fmt.Errorf("%w: %s", ErrNoSessionList, source)
			case http.StatusNotImplemented:
				return nil, Page{}, fmt.Errorf("%w: %s", ErrNotImplemented, source)
			}
		}
		// err is federation's, which never carries a response body — see the
		// PII note above. Logging it is safe and is the only record of what
		// actually went wrong, because the handler renders a sanitised 503.
		s.log.Error("onboardingfunnel: federated session read failed", "source", source, "error", err)
		return nil, Page{}, fmt.Errorf("reading %s onboarding sessions: %w", source, err)
	}

	var envelope sessionsEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		// %v on a json error is safe — encoding/json reports a position and a
		// type, never a value — but the body itself is deliberately not here.
		return nil, Page{}, s.unreadable(source, "decoding %s: %v", source, err)
	}

	if kind, ok := listKind(envelope.Data); !ok {
		return nil, Page{}, s.unreadable(source,
			"%s returned %s where a list was required — each of those reads as an empty queue",
			source, kind)
	}
	if envelope.Pagination == nil {
		return nil, Page{}, s.unreadable(source,
			"%s returned no pagination — a page with no total reads as the whole list", source)
	}
	if envelope.Pagination.Total == nil {
		return nil, Page{}, s.unreadable(source,
			"%s omitted pagination.total — an absent total reads as \"these are all of them\"",
			source)
	}

	return envelope.Data, Page{
		Total:  *envelope.Pagination.Total,
		Limit:  envelope.Pagination.Limit,
		Number: envelope.Pagination.Page,
	}, nil
}

// unreadable logs a rejected body and returns the sentinel for it.
//
// Every unreadable outcome goes through here, for two reasons. The handler
// renders all of them as one sanitised 503, so without a log line nobody can
// tell WHICH invariant a product broke. And routing them through one place is
// what makes the PII rule testable: this is the only function in the module
// that logs about a response, it is handed a message rather than a body, and
// sessions_test.go asserts that nothing it writes contains a merchant email.
//
// reason must already be safe to render. Callers pass the source slug and the
// JSON KIND that arrived; none of them passes a value out of the body.
func (s *Service) unreadable(source, format string, args ...any) error {
	err := fmt.Errorf("%w: "+format, append([]any{ErrSessionsUnreadable}, args...)...)
	s.log.Error("onboardingfunnel: session list unreadable",
		"source", source, "reason", err)
	return err
}

// listKind reports whether data is a JSON array, and names what arrived when
// it is not.
//
// This is the load-bearing half of the empty-versus-unreadable rule. The three
// shapes it rejects — absent, null, and anything that is not an array — all
// decode one layer down to "no sessions": `data ?? []` and `data.map(...)` on
// a null both render an empty queue. An empty ARRAY is explicitly allowed
// through, because that is the measurement.
//
// mark8ly's own handler allocates its slice before appending precisely so a
// nil can never marshal here, and its client does the same one hop further up.
// So a null arriving means something other than that handler answered — a
// proxy, an error page, a rewritten response — which is exactly the case that
// must not be rendered as "nobody signed up".
//
// It returns the KIND and never the value: the value on this path is very
// likely a session row, and a session row is a merchant's email address.
func listKind(data json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return "no data key", false
	}
	switch trimmed[0] {
	case '[':
		return "a list", true
	case '{':
		return "an object", false
	case '"':
		return "a string", false
	case 'n':
		return "a null list", false
	case 't', 'f':
		return "a boolean", false
	default:
		return "a number", false
	}
}
