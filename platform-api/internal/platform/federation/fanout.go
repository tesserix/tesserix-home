package federation

import (
	"context"
	"errors"
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

// sanitize strips the request URL and any dialed address out of a transport
// error, keeping only the innermost cause.
//
// `*url.Error` embeds the full URL in its Error() string, and the
// `*net.OpError` it typically wraps also embeds the dialed host:port in ITS
// Error() string (stripping only the url.Error layer still leaves the
// address behind, e.g. "dial tcp 10.0.4.12:8080: connect: connection
// refused"). This value is rendered in a browser beside the source's name,
// so we walk to the deepest wrapped error — e.g. "connection refused" — and
// use only that. The unredacted error is still what a caller logs
// server-side.
func sanitize(err error) string {
	for {
		unwrapped := errors.Unwrap(err)
		if unwrapped == nil {
			return err.Error()
		}
		err = unwrapped
	}
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
