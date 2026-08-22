package federation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrProductNotConfigured is returned for a product this deployment may not
// call. Tested with errors.Is so callers do not string-match.
var ErrProductNotConfigured = errors.New("federation: product not configured")

// ErrTransport marks an error as having come from the network rather than
// from this package's own logic.
//
// It exists because the alternative — inferring transport-ness from an error's
// type in the fan-out — kept missing cases: `*url.Error` wraps what `Do`
// returns but NOT what reading the response body returns, and `*net.OpError`,
// `*net.DNSError` and friends each embed an address in their own Error()
// string. The two lines below are the only places this package touches the
// network, so marking them here is complete by construction in a way a type
// switch elsewhere can never be.
//
// Callers must treat an ErrTransport as unsafe to show a user verbatim.
var ErrTransport = errors.New("transport failure")

// ErrRequestInvalid marks a call that could not even be turned into a request
// — in practice a product whose configured BaseURL is not a URL. net/url's
// parse error quotes the whole offending URL back at you, so this is never
// safe to show a user verbatim; sanitize renders it "product misconfigured".
var ErrRequestInvalid = errors.New("federation: request could not be built")

// statusError is a product answering with a non-2xx.
//
// It is a type rather than a sentinel so sanitize can render the status code —
// the one detail of this failure that is useful to an operator and cannot leak
// anything — without going near the error's own text.
type statusError struct {
	Slug   string
	Status int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("federation: %s responded %d", e.Slug, e.Status)
}

// Operator is who the call is being made on behalf of, and under what
// authority.
//
// Both fields are required on every call. A shared secret alone carries no
// actor, so a product would record the action against "the platform", which is
// the same as unattributed. See the integration contract §8.4.
type Operator struct {
	ID         string
	Capability string
}

// Client calls products' platform admin APIs.
type Client struct {
	reg  *Registry
	http *http.Client
}

// NewClient builds a client. A nil http.Client gets one with a timeout —
// Go's default has none, and a product that accepts the connection and never
// answers would hang a console render forever.
func NewClient(reg *Registry, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 8 * time.Second}
	}
	return &Client{reg: reg, http: hc}
}

// Get performs one federated read and returns the raw body.
func (c *Client) Get(ctx context.Context, slug, path string, op Operator) ([]byte, error) {
	if op.ID == "" || op.Capability == "" {
		return nil, fmt.Errorf("federation: refusing to call %s/%s without an operator", slug, path)
	}
	product, ok := c.reg.Get(slug)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrProductNotConfigured, slug)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, product.BaseURL+path, nil)
	if err != nil {
		return nil, fmt.Errorf("federation: building request for %s: %w: %w", slug, ErrRequestInvalid, err)
	}
	req.Header.Set("X-Internal-Auth", product.Secret)
	req.Header.Set("X-Operator-Id", op.ID)
	req.Header.Set("X-Operator-Capability", op.Capability)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("federation: calling %s: %w: %w", slug, ErrTransport, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 1 MiB. A product answering with something enormous is a bug in that
	// product; reading it all would make it this process's outage too.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("federation: reading %s response: %w: %w", slug, ErrTransport, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &statusError{Slug: slug, Status: resp.StatusCode}
	}
	return body, nil
}
