package handler

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/onboardingfunnel/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// sessionsParameters is every query parameter this route reads: the source,
// plus the five mark8ly's own sessions handler parses. Anything else is a 400.
//
// Verified against mark8ly's parseSessionsParams on 2026-08-30 (marketplace-api
// a26ec7d2): status, created_from, created_to, abandoned, page, limit — and
// nothing else. Its onboardingfunnel.Client also understands `order`, but the
// admin handler does not read it, so it is not a parameter of THIS contract
// and is deliberately absent here.
var sessionsParameters = []string{
	"source", "status", "created_from", "created_to", "abandoned", "page", "limit",
}

// maxSessionLimit is the ceiling this service puts on a page of sessions.
//
// 200, and the number is chosen against three constraints rather than picked:
//
//   - Every row is a merchant's email address. A page size is a PII blast
//     radius, and 200 is four times mark8ly's own default of 50 — enough for an
//     operator scanning a queue, far short of "export the funnel".
//   - federation.Client caps a response body at 1 MiB and returns what fits.
//     A session row is roughly 250 bytes, so 200 rows is about 50 KB: two
//     orders of magnitude under the cap. That margin is the point — the clamp
//     must bind long before the read limit does, because a truncated body
//     arrives as an unreadable list rather than a short page, and an operator
//     would see 503 where they asked for too much.
//   - It is a ceiling, not a rewrite. A smaller limit is forwarded untouched
//     and mark8ly's echoed pagination.limit still decides what `meta.limit`
//     reports, so a client always learns the size actually applied.
//
// Why clamp here at all, given mark8ly's parseSessionsParams comment says an
// oversized limit "is clamped there": the "there" in that sentence is mark8ly's
// OWN upstream onboarding service, behind /internal/onboarding/sessions — a
// service this deployment cannot see, test against, or version. A limit this
// service never bounded is a limit bounded by somebody else's deploy.
const maxSessionLimit = 200

// listSessions serves one page of one product's onboarding sessions.
//
// # This route carries PII, deliberately and with approval
//
// See the package doc on onboardingfunnel. Nothing in this function logs or
// renders any part of the product's response: the rows go to httpx.WriteMeta
// and nowhere else, and every failure below is written from this file's own
// strings. That is the whole of the wire-side discipline; the read side's is
// in service.ListSessions.
func (h *Handler) listSessions(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, sessionsParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.WriteError(w, r, httpx.BadRequest(
			"source is required: a session list is one product's queue, not the estate's"), h.log)
		return
	}

	upstream := query
	upstream.Del("source")
	if err := narrowSessionsQuery(upstream); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	rows, page, err := h.svc.ListSessions(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapPlatform),
	}, source, upstream)
	if err != nil {
		h.writeSessionsError(w, r, err)
		return
	}

	// WriteMeta, not WriteData: a page of rows with no total reads as the
	// whole list, which is how an operator working a queue stops early.
	// Total is a pointer in httpx.Meta precisely so "zero match your filter"
	// stays distinct from "this endpoint does not report totals"; the service
	// has already refused a body that omitted it, so this is always the first.
	total := page.Total
	httpx.WriteMeta(w, r, http.StatusOK, rows, &httpx.Meta{
		Total: &total,
		// mark8ly's echo of the size it applied, not the size asked for.
		Limit: page.Limit,
	}, h.log)
}

// narrowSessionsQuery validates and clamps in place, before anything is
// forwarded.
//
// Why these three are validated when the funnel validates nothing: mark8ly's
// parseSessionsParams "never errors". A value it cannot parse is DROPPED, and
// a dropped filter is not a smaller answer, it is a different question
// answered without saying so — `abandoned=yes` returns every session to an
// operator who asked for the abandoned ones, and `limit=fifty` returns a page
// size they did not choose. Refusing here is the only place that distinction
// can still be made.
//
// created_from and created_to are the same bug class and are now refused too,
// on this route and the funnel's together — see refuseUnparseableWindow in
// window.go, which is shared precisely because fixing one route and not the
// other would have left the estate's two views of the same population
// disagreeing about what a window is.
//
// status is the one parameter still forwarded unexamined, and that is a
// decision rather than an omission. Refusing an unrecognised status would
// require a canonical list of onboarding statuses, and this service has no
// honest source for one: the vocabulary belongs to mark8ly's own upstream
// onboarding service, behind /internal/onboarding/sessions, which this
// deployment cannot see or version. Hard-coding a list here would invent a
// vocabulary and then under-report against it — the far more damaging half of
// the failure registry.go warns about, because a status this service refuses
// is a status an operator can never ask for again until somebody redeploys.
//
// The asymmetry with the window is not arbitrary. A dropped created_from
// WIDENS: the filter vanishes and the answer covers everything, which is a
// different question answered silently. A mistyped status NARROWS: the filter
// is applied, faithfully, to a value nothing matches, and the operator sees a
// 200 with an empty list. That empty list is the truthful answer to what they
// actually asked, and it is visibly empty — the one thing an operator does
// notice. Nothing is hidden, so there is nothing to refuse.
func narrowSessionsQuery(query url.Values) error {
	if err := refuseUnparseableWindow(query); err != nil {
		return err
	}
	if raw := strings.TrimSpace(query.Get("abandoned")); raw != "" {
		if _, err := strconv.ParseBool(raw); err != nil {
			return httpx.BadRequest(
				"abandoned must be true or false: an unparseable value is dropped upstream, " +
					"which answers a different question without saying so")
		}
	}
	if raw := strings.TrimSpace(query.Get("page")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return httpx.BadRequest("page must be a positive whole number")
		}
	}
	raw := strings.TrimSpace(query.Get("limit"))
	if raw == "" {
		// Absent means "mark8ly's default", which is its answer to give.
		return nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return httpx.BadRequest("limit must be a positive whole number")
	}
	if n > maxSessionLimit {
		query.Set("limit", strconv.Itoa(maxSessionLimit))
	}
	return nil
}

// writeSessionsError maps a failed read onto a status the console can act on.
//
// The same four answers writeReadError draws, for the same reasons, with one
// difference that is the entire point of this route: 503 here also covers a
// 200 whose `data` was absent, null, or not an array. Each of those decodes
// one layer down to an empty queue, and an empty queue is a legitimate 200 on
// this route — so the ONLY thing keeping "we could not read the list" apart
// from "nobody signed up" is that these never reach the 200 branch.
//
// What every branch has in common, again, matters more than what separates
// them: none of them writes a `data` key, and none of them renders any part of
// the product's response.
func (h *Handler) writeSessionsError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrUnknownSource):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	case errors.Is(err, service.ErrNoProducts):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"no product on this deployment declares an onboarding funnel"), h.log)
	case errors.Is(err, service.ErrNoSessionList):
		httpx.WriteError(w, r, httpx.NotFound(
			"the product declares an onboarding funnel but does not mount a session list"), h.log)
	case errors.Is(err, service.ErrNotImplemented):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"the product reports no onboarding sessions"), h.log)
	case errors.Is(err, service.ErrSessionsUnreadable):
		// 503, not 200-with-[]. The product answered, but not with something
		// this service is willing to call a session list, and the difference
		// between that and an empty queue is the whole point.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product's onboarding sessions could not be read"), h.log)
	default:
		// Deliberately not err.Error(): a transport failure's text carries
		// hostnames, and on this route a quoted body would carry emails.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product could not be reached for its onboarding sessions"), h.log)
	}
}
