package federation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
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

// ErrSigning marks a call that could not be signed — an empty secret, a
// newline in the operator identity, or an exhausted entropy source.
//
// It is separate from ErrRequestInvalid because the two want different
// responses: a malformed BaseURL is config someone must fix, while a signing
// failure is either a bug in what we passed or a machine in trouble. Both are
// unsafe to render verbatim (an error from Sign can quote a field value back),
// so sanitize gives them the same opaque string.
var ErrSigning = errors.New("federation: request could not be signed")

// Client calls products' platform admin APIs.
type Client struct {
	reg  *Registry
	http *http.Client
	// now and nonce are injectable so the signing path is testable against a
	// published vector. Only TestGetReproducesAGoldenVectorEndToEnd replaces
	// them; every other test lets the real ones run, because a pinned nonce
	// would hide a client that never rotates it.
	now   func() time.Time
	nonce func() (string, error)
}

// NewClient builds a client. A nil http.Client gets one with a timeout —
// Go's default has none, and a product that accepts the connection and never
// answers would hang a console render forever.
func NewClient(reg *Registry, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 8 * time.Second}
	}
	return &Client{reg: reg, http: hc, now: time.Now, nonce: randomNonce}
}

// randomNonce returns 128 bits of hex. The far end claims each nonce
// single-use for the length of its replay window, so a repeat is not a
// collision risk but a rejected request — 128 bits makes that unreachable in
// practice. Hex rather than base64 because the value is signed inside a
// "\n"-joined string and hex cannot produce a character that needs thinking
// about.
func randomNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("federation: generating nonce: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// Get performs one federated read and returns the raw body.
func (c *Client) Get(ctx context.Context, slug, path string, op Operator) ([]byte, error) {
	return c.do(ctx, http.MethodGet, slug, path, nil, op, nil)
}

// ErrIdempotencyKeyRequired is returned when a write is attempted without one.
var ErrIdempotencyKeyRequired = errors.New("federation: an idempotency key is required for a write")

// PostOptions carries what a write needs beyond its body.
type PostOptions struct {
	// IdempotencyKey is REQUIRED. See Post.
	IdempotencyKey string
}

// Post performs one federated write.
//
// Deliberately not exposed through FanOut. Reading the same path from several
// products and merging the answers is a sensible thing to want; writing the
// same body to several products is not, and a partial failure across a fan-out
// of mutations has no honest representation — some of it happened.
//
// An idempotency key is REQUIRED, and this refuses without one. A transport
// error after the far end has committed is indistinguishable from one before
// it, so any retry of a mutating call is a coin flip on double application,
// and the caller does not always control the retry.
//
// The honest limit, worth knowing before relying on it: the key makes a retry
// safe only where the far end honours it. On mark8ly today exactly one
// endpoint does — POST /admin/billing/trials/{id}/extend, which refuses
// without the header — while suspend, unsuspend and purge accept the header
// and ignore it. Requiring it here is therefore necessary and not sufficient:
// it costs one line, it is right wherever the far end implements it, and it
// makes retry-safety a decision someone made rather than one nobody had.
func (c *Client) Post(
	ctx context.Context,
	slug, path string,
	body []byte,
	op Operator,
	opts PostOptions,
) ([]byte, error) {
	if opts.IdempotencyKey == "" {
		return nil, fmt.Errorf("%w: %s/%s", ErrIdempotencyKeyRequired, slug, path)
	}
	headers := map[string]string{
		"Idempotency-Key": opts.IdempotencyKey,
		"Content-Type":    "application/json",
	}
	return c.do(ctx, http.MethodPost, slug, path, body, op, headers)
}

// do is the one path every federated call takes.
//
// Get and Post share it so the signing, the operator check and the response
// limit cannot drift apart between a read and a write — which is exactly the
// kind of divergence that produces a scheme where reads work and writes 401.
func (c *Client) do(
	ctx context.Context,
	method, slug, path string,
	body []byte,
	op Operator,
	headers map[string]string,
) ([]byte, error) {
	if op.ID == "" || op.Capability == "" {
		return nil, fmt.Errorf("federation: refusing to call %s/%s without an operator", slug, path)
	}
	product, ok := c.reg.Get(slug)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrProductNotConfigured, slug)
	}

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, product.BaseURL+path, reader)
	if err != nil {
		return nil, fmt.Errorf("federation: building request for %s: %w: %w", slug, ErrRequestInvalid, err)
	}
	if err := c.sign(req, product.Secret, op, body); err != nil {
		return nil, fmt.Errorf("federation: signing request for %s: %w: %w", slug, ErrSigning, err)
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("federation: calling %s: %w: %w", slug, ErrTransport, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 1 MiB. A product answering with something enormous is a bug in that
	// product; reading it all would make it this process's outage too.
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("federation: reading %s response: %w: %w", slug, ErrTransport, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &statusError{Slug: slug, Status: resp.StatusCode}
	}
	return respBody, nil
}

// sign attaches the five signed headers mark8ly's platform admin surface
// requires (#334).
//
// It takes the built *http.Request rather than the caller's path string on
// purpose. The scheme signs the percent-DECODED path, and net/url has already
// produced exactly that in req.URL.Path — signing the caller's string instead
// would send the wire form and 401 on every path containing an encoded
// character, with nothing local to see. The same applies to RawQuery: the
// canonicaliser re-escapes it, so what the caller built it with is irrelevant,
// but it must be the query net/url parsed out rather than a substring someone
// split off by hand.
//
// body must be the exact bytes the request will carry. It is a parameter
// rather than read back off req.Body because a consumed body cannot be
// re-read: signing one set of bytes and sending another produces a signature
// the far end rejects, with no local symptom.
func (c *Client) sign(req *http.Request, secret string, op Operator, body []byte) error {
	// Defaulted here as well as in NewClient: a Client built as a struct
	// literal would otherwise panic on a nil func, and a panic in the signing
	// path takes down a fan-out goroutine rather than degrading one source.
	now, nonceFn := c.now, c.nonce
	if now == nil {
		now = time.Now
	}
	if nonceFn == nil {
		nonceFn = randomNonce
	}

	nonce, err := nonceFn()
	if err != nil {
		return err
	}

	in := SignatureInput{
		Method:   req.Method,
		Path:     req.URL.Path,
		RawQuery: req.URL.RawQuery,
		Body:     body,
		// Unsigned decimal seconds. The far end rejects a leading '+' or '-'
		// outright, and FormatInt of a positive int64 cannot produce either.
		Timestamp:  strconv.FormatInt(now().Unix(), 10),
		Nonce:      nonce,
		Operator:   op.ID,
		Capability: op.Capability,
	}

	signature, err := Sign(secret, in)
	if err != nil {
		return err
	}

	req.Header.Set(headerOperator, in.Operator)
	req.Header.Set(headerCapability, in.Capability)
	req.Header.Set(headerTimestamp, in.Timestamp)
	req.Header.Set(headerNonce, in.Nonce)
	req.Header.Set(headerSignature, signature)
	return nil
}
