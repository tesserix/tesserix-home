package federation

import (
	"context"
	"errors"
	"fmt"
	"net"
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

	if errors.Is(err, ErrRequestInvalid) || errors.Is(err, ErrProductNotConfigured) {
		return "product misconfigured"
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
func FanOut[T any](
	ctx context.Context,
	c *Client,
	slugs []string,
	path string,
	op Operator,
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
			body, err := c.Get(ctx, slug, path, op)
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
