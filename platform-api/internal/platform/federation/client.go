package federation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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

// ErrNoMatchingService is a product that IS configured, but none of whose
// services declare the entity or endpoint the call named (see Selector).
//
// Distinct from ErrProductNotConfigured: that one means "we have never heard
// of this product, or it has no services at all"; this one means "we know
// this product, and it simply does not serve this". Collapsing them would
// make a real over-declaration (a Selector naming something nothing declares)
// indistinguishable from a typo'd product slug.
var ErrNoMatchingService = errors.New("federation: no service matches")

// ErrAmbiguousService is more than one of a product's services matching the
// call's Selector.
//
// This is NOT always a misconfiguration — mark8ly's split email-template
// registry (tesserix/mark8ly#720) is the documented case where two services
// legitimately share one declaration — but Get, Post and Put are
// single-response methods and cannot honestly answer "here are two services,
// which one did you mean". Guessing (first match, last match, either) would
// silently drop one owner's data, so this fails closed instead. The caller
// wants FanOut (for a read that already merges) or FanOutServices (the
// primitive for a caller that does not yet fan out at all) to call every
// match and combine the answers.
var ErrAmbiguousService = errors.New("federation: more than one service matches; call every match instead of guessing")

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
	// Code is the product's §4.4 `error` value, when the refusal carried a
	// parseable envelope. Empty otherwise.
	//
	// Only the CODE is kept. §4.4 guarantees it is a stable machine-readable
	// identifier, which makes it safe to pass on and useful to act on; the
	// sibling `message` is free text written by another product, and this
	// package's whole discipline is that such text never reaches a browser.
	// See sanitize, which still renders a status and nothing else — a code
	// helps a WRITE's caller choose a message, and has no business being
	// interpolated into a fan-out's failure list.
	Code string
}

func (e *statusError) Error() string {
	// Deliberately does not interpolate Code. This string is not the channel
	// the code travels on — ErrorCode is — and an error's text has a way of
	// ending up rendered.
	return fmt.Sprintf("federation: %s responded %d", e.Slug, e.Status)
}

// ErrorCode reports the product's §4.4 error code from a refusal, if it
// carried one.
//
// The second return distinguishes "no code" from "the empty code": a refusal
// with an unparseable body has nothing to report, and a caller mapping codes
// to messages must not treat that as a code it failed to recognise.
func ErrorCode(err error) (string, bool) {
	var se *statusError
	if !errors.As(err, &se) || se.Code == "" {
		return "", false
	}
	return se.Code, true
}

// StatusOf reports the HTTP status a product answered a refusal with, if the
// error came from a response at all.
//
// The second return distinguishes "the product answered N" from "we never got
// an answer": a DNS failure, a TLS error and a timeout all produce an error
// with no status, and a caller that read a missing status as 0 — or worse, as
// a default — would report a transport outage as though the product had said
// something.
//
// Needed because two refusals mean opposite things to a caller. §3.1's `501`
// is a product SAYING "I am not instrumented", which is a legitimate contract
// answer to pass on; a 502 is a product failing to say anything. Collapsing
// them loses the distinction §3.1 exists to preserve — the console has to tell
// "not instrumented" from "every metric is zero", and it can only do that if
// the status survives the hop.
func StatusOf(err error) (int, bool) {
	var se *statusError
	if !errors.As(err, &se) {
		return 0, false
	}
	return se.Status, true
}

// ErrUnknownService is a slug/serviceName pair naming a product this
// deployment knows, but no service of it by that name — a typo'd service
// name, or one that has been renamed/removed from FEDERATION_<SLUG>_SERVICES.
//
// Distinct from ErrNoMatchingService: that one is "no service declares this
// endpoint/entity", answered by resolving a Selector against every service;
// this one is "no service has this NAME at all", answered by GetForService /
// PostForService / PutForService, which address a specific service a caller
// already named (mark8ly's split email-template registry,
// tesserix/mark8ly#720, addressing "platform-api" out of an id's
// `slug/service` half) rather than one FanOutServices resolved for them.
var ErrUnknownService = errors.New("federation: unknown service")

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
//
// Resolves with a zero-value Selector — Product.resolve's fallback, every
// Service unfiltered — so it keeps working byte-identically for every
// single-service product (kora, and mark8ly before it declares a second
// service): one Service in, one Service out, same as before #720. A call
// site that DOES know
// what §3.2 endpoint or §3.4 entity it is reading should call GetForEndpoint
// or GetForEntity instead, so a product configured with more than one
// service can be resolved rather than refused.
func (c *Client) Get(ctx context.Context, slug, path string, op Operator) ([]byte, error) {
	return c.get(ctx, slug, path, op, Selector{})
}

// GetForEndpoint is Get, resolving within the named §3.2 contract (or
// product-own) endpoint — see Selector.ForEndpoint.
func (c *Client) GetForEndpoint(ctx context.Context, slug, endpoint, path string, op Operator) ([]byte, error) {
	return c.get(ctx, slug, path, op, ForEndpoint(endpoint))
}

// GetForEntity is Get, resolving within the named §3.4 entity type — see
// Selector.ForEntity.
func (c *Client) GetForEntity(ctx context.Context, slug, entity, path string, op Operator) ([]byte, error) {
	return c.get(ctx, slug, path, op, ForEntity(entity))
}

// get is what Get, GetForEndpoint, GetForEntity and FanOut all share.
func (c *Client) get(ctx context.Context, slug, path string, op Operator, sel Selector) ([]byte, error) {
	return c.do(ctx, http.MethodGet, slug, path, nil, op, nil, sel)
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
	return c.write(ctx, http.MethodPost, slug, path, body, op, opts, Selector{})
}

// PostForEndpoint is Post, resolving within the named endpoint — see
// Selector.ForEndpoint and Get's doc comment for why a call site that knows
// its endpoint should prefer this over Post.
func (c *Client) PostForEndpoint(
	ctx context.Context,
	slug, endpoint, path string,
	body []byte,
	op Operator,
	opts PostOptions,
) ([]byte, error) {
	return c.write(ctx, http.MethodPost, slug, path, body, op, opts, ForEndpoint(endpoint))
}

// PostForEntity is Post, resolving within the named §3.4 entity type — see
// Selector.ForEntity.
func (c *Client) PostForEntity(
	ctx context.Context,
	slug, entity, path string,
	body []byte,
	op Operator,
	opts PostOptions,
) ([]byte, error) {
	return c.write(ctx, http.MethodPost, slug, path, body, op, opts, ForEntity(entity))
}

// Put performs one federated write to a named resource.
//
// Everything Post's documentation says applies here unchanged — the idempotency
// key is required for the same reason, and the honest limit on what it buys is
// the same. It is a separate method rather than a `method` parameter on Post
// because the two verbs are the ones the contract uses and a free-form method
// argument would let a caller send a DELETE through a helper whose whole
// docstring is about writes.
//
// The verb is the product's choice, not ours: mark8ly serves the email
// template registry as PUT /admin/email-templates/{key} because the write is
// an upsert of a named row, and a client that turned that into a POST would
// simply 404 (gin routes on the method).
func (c *Client) Put(
	ctx context.Context,
	slug, path string,
	body []byte,
	op Operator,
	opts PostOptions,
) ([]byte, error) {
	return c.write(ctx, http.MethodPut, slug, path, body, op, opts, Selector{})
}

// PutForEndpoint is Put, resolving within the named endpoint — see
// Selector.ForEndpoint. mark8ly's email-template registry (§4, PUT
// /admin/email-templates/{key}) is exactly the endpoint two services may
// legitimately share, which is why Put itself cannot be taught to resolve one
// safely: a caller that reaches ErrAmbiguousService through this method is
// the case Client.Get's docstring on that error describes, and must move to
// a fan-out rather than pick a service here.
func (c *Client) PutForEndpoint(
	ctx context.Context,
	slug, endpoint, path string,
	body []byte,
	op Operator,
	opts PostOptions,
) ([]byte, error) {
	return c.write(ctx, http.MethodPut, slug, path, body, op, opts, ForEndpoint(endpoint))
}

// GetForService reads from the ONE named service of slug, addressed by name
// rather than resolved by Selector.
//
// Added for tesserix/mark8ly#720's split email-template registry: a
// `slug/service:key` id already names which of a product's services owns the
// row, and re-resolving that through GetForEndpoint's Selector would 501 with
// ErrAmbiguousService — the very failure this method exists to avoid, because
// the caller is not asking "which service serves this", it is TELLING this
// package which one. GetForEndpoint remains right for a bare `slug:key` id,
// where the caller has no service name and wants the product's default.
func (c *Client) GetForService(ctx context.Context, slug, serviceName, path string, op Operator) ([]byte, error) {
	return c.forService(ctx, http.MethodGet, slug, serviceName, path, nil, op, nil)
}

// PostForService is Post, addressed to the one named service — see
// GetForService.
func (c *Client) PostForService(
	ctx context.Context, slug, serviceName, path string, body []byte, op Operator, opts PostOptions,
) ([]byte, error) {
	if opts.IdempotencyKey == "" {
		return nil, fmt.Errorf("%w: %s/%s", ErrIdempotencyKeyRequired, slug, path)
	}
	headers := map[string]string{"Idempotency-Key": opts.IdempotencyKey, "Content-Type": "application/json"}
	return c.forService(ctx, http.MethodPost, slug, serviceName, path, body, op, headers)
}

// PutForService is Put, addressed to the one named service — see
// GetForService.
func (c *Client) PutForService(
	ctx context.Context, slug, serviceName, path string, body []byte, op Operator, opts PostOptions,
) ([]byte, error) {
	if opts.IdempotencyKey == "" {
		return nil, fmt.Errorf("%w: %s/%s", ErrIdempotencyKeyRequired, slug, path)
	}
	headers := map[string]string{"Idempotency-Key": opts.IdempotencyKey, "Content-Type": "application/json"}
	return c.forService(ctx, http.MethodPut, slug, serviceName, path, body, op, headers)
}

// forService is what GetForService, PostForService and PutForService share:
// look up slug's product, find the one service named serviceName, and call
// it directly — no Selector, no ambiguity to fail closed on, because the
// caller already named the exact service.
func (c *Client) forService(
	ctx context.Context,
	method, slug, serviceName, path string,
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
	for _, svc := range product.Services {
		if svc.Name == serviceName {
			return c.callService(ctx, method, slug, svc, path, body, op, headers)
		}
	}
	return nil, fmt.Errorf("%w: %s/%s", ErrUnknownService, slug, serviceName)
}

// ServiceNamesFor is the names of slug's own services that declare endpoint,
// in Product.Services declaration order — the same set FanOutServices(ctx, c,
// slug, ForEndpoint(endpoint), …) calls.
//
// Returns only names, never a Service value: a caller outside this package
// (the emailtemplates module building Sources(), tesserix/mark8ly#720) needs
// to enumerate and label services, not to hold their BaseURL or Secret.
// Returns nil for an unconfigured slug, the same absence-means-no-data shape
// the rest of this package's lookups take.
func (c *Client) ServiceNamesFor(slug, endpoint string) []string {
	product, ok := c.reg.Get(slug)
	if !ok {
		return nil
	}
	matches := product.resolve(ForEndpoint(endpoint))
	names := make([]string, 0, len(matches))
	for _, svc := range matches {
		names = append(names, svc.Name)
	}
	return names
}

// DefaultServiceName is the service a bare, unqualified call — a
// selector-less Get/Post/Put, or a `slug:key` id with no `/service` half —
// resolves to for slug: Product.DefaultService for a multi-service product,
// or its one service's name otherwise (Product.resolve never consults
// DefaultService there either — see resolveDefaultService — so kora and
// mark8ly-before-#720 are unaffected). The second return is false for an
// unconfigured slug, a product with no services, or a multi-service product
// with no DefaultService set (which LoadRegistry itself refuses at boot, so
// reaching this in production means the Product was built directly rather
// than loaded).
func (c *Client) DefaultServiceName(slug string) (string, bool) {
	product, ok := c.reg.Get(slug)
	if !ok || len(product.Services) == 0 {
		return "", false
	}
	if len(product.Services) == 1 {
		return product.Services[0].Name, true
	}
	if product.DefaultService == "" {
		return "", false
	}
	return product.DefaultService, true
}

// IsDefaultService reports whether serviceName is the service DefaultServiceName
// names for slug — false for an unconfigured slug or a name that is not it.
func (c *Client) IsDefaultService(slug, serviceName string) bool {
	def, ok := c.DefaultServiceName(slug)
	return ok && def == serviceName
}

// write is what Post and Put share, so the idempotency guard and the headers
// cannot drift between two verbs that differ only in the method.
func (c *Client) write(
	ctx context.Context,
	method, slug, path string,
	body []byte,
	op Operator,
	opts PostOptions,
	sel Selector,
) ([]byte, error) {
	if opts.IdempotencyKey == "" {
		return nil, fmt.Errorf("%w: %s/%s", ErrIdempotencyKeyRequired, slug, path)
	}
	headers := map[string]string{
		"Idempotency-Key": opts.IdempotencyKey,
		"Content-Type":    "application/json",
	}
	return c.do(ctx, method, slug, path, body, op, headers, sel)
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
	sel Selector,
) ([]byte, error) {
	if op.ID == "" || op.Capability == "" {
		return nil, fmt.Errorf("federation: refusing to call %s/%s without an operator", slug, path)
	}
	product, ok := c.reg.Get(slug)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrProductNotConfigured, slug)
	}
	// Product.resolve returns every Service for a zero-value sel — the
	// fallback every call site not yet updated for tesserix/mark8ly#720
	// takes. For a single-service product that is exactly one Service, and
	// the switch below resolves it exactly as this package always has. A
	// call site that named an endpoint or entity (GetForEndpoint,
	// GetForEntity, …) gets filtered down to the service(s) that actually
	// declare it instead.
	//
	// The 0/1/many split below is what decides whether a Selector was
	// necessary, not resolve() — a zero-value sel on a multi-service product
	// reaches the same "more than one, no context" fail-closed branch a
	// mismatched endpoint/entity would.
	services := product.resolve(sel)
	switch len(services) {
	case 0:
		return nil, fmt.Errorf(
			"%w: %s has no service for %s (path %s)",
			ErrNoMatchingService, slug, sel.describe(), path)
	case 1:
		// svc set below.
	default:
		return nil, fmt.Errorf(
			"%w: %s has %d services for %s (path %s)",
			ErrAmbiguousService, slug, len(services), sel.describe(), path)
	}
	return c.callService(ctx, method, slug, services[0], path, body, op, headers)
}

// callService is the transport step every resolved call ends at, whether
// resolution found exactly one service (do, above) or FanOutServices is
// calling several matches one at a time. Split out of do so the two share the
// exact same request-building, signing and response handling — the one thing
// this package cannot afford to have drift between a single-service call and
// a fanned-out one is what counts as success.
func (c *Client) callService(
	ctx context.Context,
	method, slug string,
	svc Service,
	path string,
	body []byte,
	op Operator,
	headers map[string]string,
) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, svc.BaseURL+path, reader)
	if err != nil {
		return nil, fmt.Errorf("federation: building request for %s: %w: %w", slug, ErrRequestInvalid, err)
	}
	if err := c.sign(req, svc.Secret, op, body); err != nil {
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
		return nil, &statusError{Slug: slug, Status: resp.StatusCode, Code: errorCodeOf(respBody)}
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

// errorCodeOf reads the §4.4 `error` code out of a refusal's body.
//
// Best-effort by design: a product that answers a 502 with an HTML gateway
// page has no code to give, and that is not itself an error — the status is
// still the failure. Returning "" lets ErrorCode report "no code" rather than
// inventing one.
func errorCodeOf(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	return envelope.Error
}
