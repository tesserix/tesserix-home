package federation

import (
	"context"
	"errors"
	"net"
	"net/url"
	"sync"
)

// Failure is one source that could not be read.
//
// Error is a string rather than an error because it crosses the HTTP boundary
// into the console, which renders it beside the source's name. It must never
// carry a secret or an internal URL.
type Failure struct {
	Product string `json:"product"`
	Error   string `json:"error"`
}

// sanitize maps a failure to a string that is safe to render in a browser.
//
// This value is shown in the console beside the source's name, so it must
// never carry an internal hostname, address, or URL. It is an ALLOWLIST, not
// an attempt to strip identifiers out of arbitrary error text: `*url.Error`,
// `*net.OpError`, `*net.DNSError` and several TLS errors each embed an
// address in their own Error() string, and unwrapping to the deepest cause
// does not help — `*net.DNSError.UnwrapErr` may be nil, so unwrapping stops
// there and returns "lookup <host> on <server>: no such host".
//
// `http.Client.Do` always returns a `*url.Error` when a request fails, so
// that type is a complete gate for transport failures. Everything else is an
// error this package constructed, whose text we control.
//
// The unredacted error is still what a caller logs server-side.
func sanitize(err error) string {
	var urlErr *url.Error
	if !errors.As(err, &urlErr) {
		// Not a transport failure: our own error text, safe as written.
		return err.Error()
	}

	switch {
	case errors.Is(err, context.Canceled):
		return "request canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timed out"
	}

	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "name resolution failed"
	}
	if urlErr.Timeout() {
		return "timed out"
	}
	return "connection failed"
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
			failures = append(failures, Failure{Product: slugs[i], Error: sanitize(r.err)})
			continue
		}
		merged = append(merged, r.rows...)
	}
	return merged, failures
}
