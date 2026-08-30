package handler

import (
	"net/url"
	"strings"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// windowParameters is the created_from/created_to pair, which BOTH routes in
// this module take and which mark8ly reads through the same parseTime on both.
// One list, so the two routes cannot drift into disagreeing about what a
// window is — the funnel and the sessions list describe the same population
// over the same interval, and a caller who narrows one and then the other
// expects the same string to mean the same thing.
var windowParameters = []string{"created_from", "created_to"}

// refuseUnparseableWindow refuses a created_from or created_to that mark8ly
// would silently drop, before anything is forwarded.
//
// # The failure this exists to prevent
//
// mark8ly's parseSessionsParams and funnel handler both read the window
// through parseTime, and parseTime does not error. It returns (zero, false)
// for anything it cannot parse, and the caller then leaves the field UNSET:
//
//	if t, ok := parseTime(c.Query("created_from")); ok {
//	    p.CreatedFrom = t
//	}
//
// An unset lower bound is not a lower bound of "roughly what you meant". It
// is no lower bound at all, so `created_from=2026-08-01` — a perfectly
// reasonable thing for a human to type — silently WIDENS the window to all
// time. The operator asked for a week and was answered about the estate's
// entire history, with a 200 and no indication that a substitution happened.
//
// This is the same bug class narrowSessionsQuery already refuses for
// limit/page/abandoned, and it is the worst member of it. On the sessions
// route a widened window at least arrives as rows an operator might notice
// are too old. On the funnel route the answer is a set of counters with
// nothing to eyeball: the window line reads "all time", which is TRUE and is
// exactly why it does not read as a refusal to anybody who was not already
// suspicious of their own URL.
//
// # Why refuse rather than repair
//
// Guessing — reading `2026-08-01` as midnight UTC, say — would answer a
// question the caller did not ask, in a time zone this service has no basis
// for choosing. That is the same substitution, made politely. A 400 is the
// only response that leaves the caller in possession of the fact that their
// window did not take.
//
// # What is accepted
//
// Exactly what mark8ly accepts, because this hop must never refuse a request
// the product would have honoured: RFC 3339, via the identical
// time.Parse(time.RFC3339, strings.TrimSpace(v)) that parseTime performs
// (marketplace-api, internal/handlers/platformadmin/audit_logs.go). Verified
// by running it on 2026-08-30 rather than read off its name — that admits
// fractional seconds and numeric zone offsets (`+05:30`) as well as `Z`, and
// Go's strict RFC 3339 path rejects a lowercase `t`/`z` separator. Calling
// the same function is what keeps the two ends from drifting apart when
// either is upgraded.
//
// The value is trimmed only to DECIDE. What is forwarded is the caller's
// bytes, untouched: mark8ly trims for itself, and a window this layer rewrote
// would make the product's echo of the effective window a claim about a
// string nobody sent.
//
// An empty value is accepted and forwarded as-is. parseTime returns false for
// "" too, but that drop is the absence of a bound expressed as an empty
// string — nothing is answered differently from what was asked, so there is
// nothing to refuse.
//
// # This narrows an already-deployed contract
//
// /v1/onboarding/funnel is live and the console calls it. A 400 where there
// was a silent pass-through is a behaviour change, made deliberately. It
// cannot break the console today: fetchOnboardingFunnel builds its query as
// `new URLSearchParams({ source })` and sends no window at all (verified in
// apps/console/lib/platform-api.ts, and pinned by its own test asserting the
// URL is exactly `/v1/onboarding/funnel?source=mark8ly`). The next caller to
// send one is the reason this is worth doing now rather than after that
// caller exists and has learned to rely on the drop.
func refuseUnparseableWindow(query url.Values) error {
	for _, name := range windowParameters {
		raw := strings.TrimSpace(query.Get(name))
		if raw == "" {
			continue
		}
		if _, err := time.Parse(time.RFC3339, raw); err != nil {
			return httpx.BadRequest(name + " must be an RFC 3339 timestamp, for example " +
				"2026-08-01T00:00:00Z: a value the product cannot parse is dropped there, " +
				"which widens the window to all time without saying so").
				WithDetails(map[string]any{name: query.Get(name)})
		}
	}
	return nil
}
