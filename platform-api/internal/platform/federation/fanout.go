package federation

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
)

// Failure is one source that could not be read.
//
// Error is a string rather than an error because it crosses the HTTP boundary
// into the console, which renders it beside the source's name. It is always
// one of the closed set of strings sanitize builds, so it cannot carry a
// secret, an internal hostname, an address, or a URL.
type Failure struct {
	Product string `json:"product"`
	Error   string `json:"error"`
	// cause is the unredacted error, for server-side logging only.
	//
	// Unexported, so encoding/json omits it: the wire shape the console
	// receives is unchanged and the closed-set guarantee on Error still
	// holds. Reached via Unwrap() so a caller can log the real failure
	// without the browser ever seeing it.
	cause error
}

// Unwrap returns the unredacted cause, for server-side logging.
//
// Called DIRECTLY, never through errors.Is/As on a Failure: Failure has an
// `Error` field, not an `Error() string` method, so it is not an error and
// `errors.Is(f, …)` does not compile. Classify the value this returns instead.
//
// Failure.Error is deliberately a coarse, closed-set string because it is
// rendered in a browser. This is the other half of that trade: the caller
// keeps the detail, the page does not.
func (f Failure) Unwrap() error { return f.cause }

// errDecode marks a failure in the caller-supplied decode func. Unlike the
// other classes, this one is raised here rather than in client.go, because
// decoding is the one step FanOut performs itself.
var errDecode = errors.New("federation: decoding response")

// sanitize maps a failure to a string that is safe to render in a browser.
//
// It NEVER returns an arbitrary error's text. Every failure becomes one of a
// small closed set of strings built entirely from values this package
// controls, plus — for a non-2xx — a status code. There is deliberately no
// pass-through arm.
//
// That is the whole point. Four earlier versions tried to DETECT unsafe text
// and strip or classify it: unwrap `*url.Error` one layer (`*net.OpError`
// still carries host:port), unwrap to the deepest cause (`*net.DNSError` has
// a nil UnwrapErr, so the walk stops on "lookup <host> on <server>"), gate on
// `*url.Error` (a mid-body-read reset happens after Do returns and is not one),
// and gate on ErrTransport with a pass-through for everything else (a
// malformed BaseURL fails in net/url, which quotes the URL back at you). Each
// leaked. Detection is a denylist and denylists lose; an error's Error() text
// is written by whoever authored the error — including net/*, including a
// FUTURE CALLER's decode func — so none of it can be trusted here.
//
// Only the string is narrowed, never the error. Client.Get returns the full
// error, and FanOut keeps it on Failure.cause (reachable via Unwrap), so a
// caller still logs the unredacted cause server-side.
func sanitize(err error) string {
	// Transport, first: it is the only class with sub-classes worth telling
	// apart, and client.go marks it at the two lines that touch the network.
	if errors.Is(err, ErrTransport) {
		switch {
		case errors.Is(err, context.Canceled):
			return "request canceled"
		case errors.Is(err, context.DeadlineExceeded):
			return "timed out"
		}
		if _, ok := errors.AsType[*net.DNSError](err); ok {
			return "name resolution failed"
		}
		if netErr, ok := errors.AsType[net.Error](err); ok && netErr.Timeout() {
			return "timed out"
		}
		return "connection failed"
	}

	if errors.Is(err, ErrRequestInvalid) || errors.Is(err, ErrProductNotConfigured) ||
		errors.Is(err, ErrNoMatchingService) {
		return "product misconfigured"
	}
	// Ambiguous, not misconfigured: the product IS configured and DOES serve
	// this, on more than one service. A caller reaching this from FanOut
	// asked a per-slug Get for something mark8ly's split email-template
	// registry (#720) is the documented case of — see ErrAmbiguousService.
	if errors.Is(err, ErrAmbiguousService) {
		return "more than one service answers for this product"
	}
	// Kept apart from "product misconfigured" because it is not always
	// config: an empty secret is, but a newline in the operator identity or a
	// dead entropy source is not, and sending an operator to check the wrong
	// thing costs more than the extra arm does. Still a fixed string — an
	// error from Sign can quote a field value back.
	if errors.Is(err, ErrSigning) {
		return "request could not be signed"
	}
	if statusErr, ok := errors.AsType[*statusError](err); ok {
		return fmt.Sprintf("responded %d", statusErr.Status)
	}
	if errors.Is(err, errDecode) {
		return "invalid response"
	}
	return "failed"
}

// FanOut reads the same path from several products concurrently and returns
// what answered plus what did not.
//
// It never returns an error. A product being down degrades one source; the
// caller still has a page to render, and the failure list is what makes the
// gap honest rather than invisible. That is the whole contract the console's
// audit surface already consumes.
//
// Both return values are non-nil even when empty: a nil slice serialises as
// `{}` rather than `[]`, which defeats every caller's `?? []` and has already
// crashed a console page in this estate precisely when there was no data.
//
// sel is the same Selector Client.GetForEndpoint / GetForEntity take, and for
// the same reason: `slugs` is a list of PRODUCTS, and a product configured
// with more than one Service (tesserix/mark8ly#720) needs to know which one
// each call is for. Pass the zero value only where the caller genuinely has
// no such context (audit's /admin/audit-logs, which every service answers
// identically and which nothing declares in Service.Endpoints) — everywhere
// `slugs` itself came from SlugsImplementing(endpoint) or
// SlugsServing(entity), pass ForEndpoint(endpoint) / ForEntity(entity) so a
// product with more than one service resolves instead of failing.
func FanOut[T any](
	ctx context.Context,
	c *Client,
	slugs []string,
	path string,
	op Operator,
	sel Selector,
	decode func(slug string, body []byte) ([]T, error),
) ([]T, []Failure) {
	type result struct {
		rows []T
		err  error
	}
	results := make([]result, len(slugs))

	var wg sync.WaitGroup
	for i, slug := range slugs {
		wg.Add(1)
		go func(i int, slug string) {
			defer wg.Done()
			// sel resolves WITHIN each product exactly the way Client.do
			// resolves for GetForEndpoint/GetForEntity — a zero-value sel
			// resolves to every Service unfiltered, unchanged from before
			// this parameter existed (and identical for a single-service
			// product either way). It is the caller's job to pass the same
			// endpoint or entity it used to build `slugs` in the first
			// place (Registry.SlugsImplementing / SlugsServing), so a
			// product declaring the endpoint on exactly one service —
			// every case in production today — resolves the same single
			// service it always did. A product declaring it on MORE than
			// one (mark8ly's split email-template registry, #720) is a
			// case this per-slug call cannot merge — see ErrAmbiguousService
			// — and surfaces as this slug's Failure, naming FanOutServices
			// as the way to actually read every match.
			body, err := c.get(ctx, slug, path, op, sel)
			if err != nil {
				results[i] = result{err: err}
				return
			}
			rows, err := decode(slug, body)
			if err != nil {
				// decode is caller-supplied, so its text is not ours to
				// trust — mark it so sanitize can classify it without
				// reading it.
				err = fmt.Errorf("federation: decoding %s response: %w: %w", slug, errDecode, err)
			}
			results[i] = result{rows: rows, err: err}
		}(i, slug)
	}
	wg.Wait()

	// Collected in the order asked, not the order they answered, so two
	// identical outages produce two identical responses.
	merged := make([]T, 0)
	failures := make([]Failure, 0)
	for i, r := range results {
		if r.err != nil {
			failures = append(failures, Failure{
				Product: slugs[i],
				Error:   sanitize(r.err),
				cause:   r.err,
			})
			continue
		}
		merged = append(merged, r.rows...)
	}
	return merged, failures
}

// ServiceResult is one service's raw answer, for FanOutServices.
type ServiceResult struct {
	// Service is the Service.Name that answered — NOT the product slug:
	// FanOutServices operates within one already-named product, and a name
	// like "platform-api" is the only thing that tells two results for the
	// same slug apart.
	Service string
	Body    []byte
	Err     error
}

// Failure builds the same safe-to-render Failure FanOut's own per-product
// loop builds, for one ServiceResult that failed.
//
// product is the caller's, not this package's: FanOutServices already knows
// which product it was calling (the slug parameter), but ServiceResult itself
// does not carry it back — Service alone (see its doc comment) is what tells
// two results apart, and a caller merging several slugs' results still needs
// the product name on the failure line. Exists so a module built on
// FanOutServices (mark8ly's split email-template registry,
// tesserix/mark8ly#720) renders a failed service exactly as safely as FanOut
// already renders a failed product — via the same sanitize, not a second
// copy of its judgment calls — rather than reaching for r.Err.Error() and
// leaking a hostname into a browser.
func (r ServiceResult) Failure(product string) Failure {
	return Failure{Product: product, Error: sanitize(r.Err), cause: r.Err}
}

// FanOutServices calls every one of slug's services matching sel, concurrently,
// and returns one ServiceResult per match — in Service declaration order, so
// two identical configurations produce identically ordered results.
//
// It is the primitive Get, Post, Put and FanOut's per-slug call all refuse to
// be: ErrAmbiguousService is exactly those methods saying "I cannot honestly
// answer this with one response", and this is where a caller that actually
// wants every match, rather than a single answer, goes instead of guessing.
// mark8ly's split email-template registry (tesserix/mark8ly#720) —
// marketplace-api and platform-api BOTH declaring `email-templates` — is the
// documented, legitimate case this exists for.
//
// The returned error is non-nil ONLY when slug itself could not be resolved
// at all — unconfigured (ErrProductNotConfigured), or configured with no
// service matching sel (ErrNoMatchingService). Once there is at least one
// match, every match's own success or failure is carried on its
// ServiceResult.Err instead, the same "degrade one source, do not fail the
// whole read" contract FanOut keeps — a caller merging two services' rows
// must be able to keep the one that answered even when its sibling did not.
//
// NOT YET WIRED INTO ANY MODULE. The emailtemplates module's List already
// fans out with FanOut(ctx, fed, slugs, path, op, ForEndpoint("email-templates"), decode)
// across PRODUCTS; the day mark8ly declares `email-templates` on two
// services, that per-slug call becomes ambiguous and mark8ly's entry in
// List's failure list reads "more than one service answers for this
// product" until something calls FanOutServices for that slug instead and
// merges its two ServiceResults into the page. That wiring — matching
// domain.Row's Source/ID stamping to two SERVICES sharing one product slug —
// is deliberately left to whoever does it (tesserix/mark8ly#720's follow-up):
// this function's job stops at "call every match and hand back the raw
// answers", not at deciding how a specific module's domain shape should
// represent two services under one product slug.
func FanOutServices(
	ctx context.Context,
	c *Client,
	slug string,
	sel Selector,
	path string,
	op Operator,
) ([]ServiceResult, error) {
	if op.ID == "" || op.Capability == "" {
		return nil, fmt.Errorf("federation: refusing to call %s/%s without an operator", slug, path)
	}
	product, ok := c.reg.Get(slug)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrProductNotConfigured, slug)
	}
	services := product.resolve(sel)
	if len(services) == 0 {
		return nil, fmt.Errorf(
			"%w: %s has no service for %s (path %s)",
			ErrNoMatchingService, slug, sel.describe(), path)
	}

	results := make([]ServiceResult, len(services))
	var wg sync.WaitGroup
	for i, svc := range services {
		wg.Add(1)
		go func(i int, svc Service) {
			defer wg.Done()
			body, err := c.callService(ctx, http.MethodGet, slug, svc, path, nil, op, nil)
			results[i] = ServiceResult{Service: svc.Name, Body: body, Err: err}
		}(i, svc)
	}
	wg.Wait()
	return results, nil
}
