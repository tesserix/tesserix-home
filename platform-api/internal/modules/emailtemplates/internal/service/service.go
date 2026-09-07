// Package service reads and writes product email template registries over the
// federation contract.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is the contract path every source serves this registry on.
//
// Product-declared rather than universal, like §3.4's entity endpoint and
// unlike /admin/audit-logs: a product with no transactional email has no
// registry, and asking it would answer 404 and render as a failed source.
// Which products serve it is the caller's declaration (Config.Slugs).
const productPath = "/admin/email-templates"

// endpoint is the §3.2 contract name this registry federates under — the
// same string passed to federation.ForEndpoint, Registry.SlugsImplementing
// and Client.ServiceNamesFor everywhere this module touches the federation
// package. One constant so the four call sites cannot drift to different
// strings.
const endpoint = "email-templates"

// idSeparator namespaces a key with the SOURCE that owns it. See domain.Row
// and split.
const idSeparator = ":"

// serviceSeparator namespaces a source's slug from a non-default service
// name — "mark8ly/platform-api" — when a product has more than one service
// answering this registry.
//
// # Why a suffix, not a rewrite
//
// mark8ly's split email-template registry (tesserix/mark8ly#720) put a
// second product-facing service under a slug this surface already had ids
// for. Two shapes were open: make every id `slug/service:key` and migrate the
// existing `mark8ly:orderdoc_invoice` ids, or keep the existing form for
// whichever service is the product's DEFAULT and add the suffix only for the
// rest. This module takes the second: ids appear in the console UI and in
// deep links, and silently rewriting every id already in front of an operator
// is a bigger blast radius than adding a new form nobody has seen yet. Kora
// and every other single-service product are unaffected either way — they
// have no second service to suffix.
//
// The `<source>:<key>` contract still holds exactly: `source` merely grew
// richer, split still splits on the FIRST `:`, and the key half is untouched.
const serviceSeparator = "/"

// keyPattern is what may be interpolated into a product's URL path.
//
// A whitelist rather than an escape, and both are applied. `id` arrives from
// the caller, its second half becomes a path segment, and a key containing
// `/` or `..` would let a caller aim a SIGNED, operator-attributed request at
// any path under the product's platform admin prefix — the one place in this
// service where a path traversal is also an authenticated one. Every key in
// either mark8ly registry is lower-snake (`orderdoc_invoice`,
// `giftcard_delivery`, `dunning_day_5`), so this refuses nothing real.
var keyPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

var (
	// ErrNotInstrumented is the answer when NO product declares this endpoint.
	//
	// An empty registry is not a real answer here the way an empty queue is —
	// a product that serves the endpoint always has registered keys — but the
	// distinction is carried for the reason §1c gives: the console renders a
	// 501 as "not wired yet" and everything else as an error, and a deployment
	// that has simply not declared FEDERATION_<SLUG>_ENDPOINTS must not look
	// like an outage.
	ErrNotInstrumented = errors.New("emailtemplates: no products serve an email template registry")
	// ErrUnknownSource names a product, or a product/service pair, this
	// deployment cannot call. Refused rather than answered empty, so a typo
	// does not read as "that source has no templates".
	ErrUnknownSource = errors.New("emailtemplates: unknown source")
	// ErrMalformedID is an id that names no product, or whose key is not one
	// this surface will put in a URL.
	ErrMalformedID = errors.New("emailtemplates: malformed template id")
	// ErrNoDefaultService is a bare (service-less) source whose product has
	// more than one service and no resolvable default.
	//
	// LoadRegistry itself refuses to boot a multi-service product with no
	// FEDERATION_<SLUG>_DEFAULT_SERVICE (see resolveDefaultService), so this
	// is reachable only if a Registry was built directly rather than loaded —
	// a test doing so, or a future loader that skips that check. It is kept
	// as a real, handled error rather than a panic because "reachable only by
	// misconfiguration" is exactly the class of thing this module's own
	// federation dependency is built to degrade rather than crash on.
	ErrNoDefaultService = errors.New("emailtemplates: source has no default service configured")
)

// Upsert is the write body, in the product's own spelling so it is forwarded
// rather than translated.
//
// Status is `draft` or `published` and is validated BY THE PRODUCT, not here:
// which statuses exist is the product's vocabulary, and a copy of it in this
// module is a second list free to drift — the argument the tenants module
// makes for lifecycle reason codes, and the reason its refusal is surfaced
// with the product's own error code rather than pre-empted.
type Upsert struct {
	Subject   string            `json:"subject"`
	HTMLBody  string            `json:"html_body"`
	TextBody  string            `json:"text_body"`
	Variables []domain.Variable `json:"variables"`
	Status    string            `json:"status"`
}

// TestSendRequest is the test-send body. `to` is required and has no default:
// a server-side default would have to invent an address, and this sends a real
// email to whatever it is given.
type TestSendRequest struct {
	To   string         `json:"to"`
	Vars map[string]any `json:"vars"`
}

// Service reads and writes the estate's template registries.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

// New builds the service. slugs is every product declaring `email-templates`
// — see Config.Slugs. log receives one ERROR line per federation failure
// carrying the unredacted cause — the wire-facing domain.Failure is a coarse,
// closed-set string, so without this line a production outage is
// undiagnosable.
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Sources is every product/service pair this deployment can ask, in the same
// `source` values a row's Source field and an id's source half use — a bare
// slug for a product's default service, `slug/service` for any other. This is
// what drives the console's `?source=` filter, so it must enumerate exactly
// what List can produce, not merely which products are configured: a filter
// offering "mark8ly" while rows also read "mark8ly/platform-api" would leave
// half the registry unreachable through it.
func (s *Service) Sources() []string {
	out := make([]string, 0, len(s.slugs))
	for _, slug := range s.slugs {
		for _, svc := range s.fed.ServiceNamesFor(slug, endpoint) {
			out = append(out, s.sourceLabel(slug, svc))
		}
	}
	return out
}

// sourceLabel is the `source` value one (slug, service) pair renders as: the
// bare slug for that product's default service, `slug/service` otherwise. The
// single place this module decides that, so a row's Source, an id built from
// scratch (TestSend) and Sources() cannot disagree on the same pair.
func (s *Service) sourceLabel(slug, service string) string {
	if s.fed.IsDefaultService(slug, service) {
		return slug
	}
	return slug + serviceSeparator + service
}

// List merges every configured product's registry, or one named by source.
//
// There is no pagination and no limit, unlike every other fan-out in this
// service. The key set is CLOSED and owned by code — a key exists because a Go
// call site renders it — so it is a few dozen entries per product that cannot
// grow at runtime. A limit parameter over a fixed set would be furniture, and
// a console would build paging controls for a page that can never have a
// second one. The federation client's 1 MiB read limit is the only bound, and
// bodies are deliberately not in this shape so it is nowhere near reached.
//
// # One product, several services
//
// Reading is FanOutServices, not FanOut: a product may answer this endpoint
// from more than one service (mark8ly's split registry, #720), and each
// match must contribute its own rows AND its own failure — an operator
// seeing five templates instead of eleven, with no failure surfaced, is the
// one outcome this exists to prevent. A slug that cannot be resolved AT ALL
// (unconfigured, or no service matches) still degrades to a single
// slug-level failure, the same shape List has always produced for that case.
func (s *Service) List(ctx context.Context, op federation.Operator, source string) (domain.Page, error) {
	if len(s.slugs) == 0 {
		// Checked before the source filter: with nothing configured every
		// source is unknown, and "you asked for a product that does not exist"
		// is a misleading way to say "this deployment federates no registry".
		return domain.Page{}, ErrNotInstrumented
	}

	slugs := s.slugs
	svcFilter := ""
	if source != "" {
		slug, svc, err := s.parseSource(source)
		if err != nil {
			return domain.Page{}, err
		}
		slugs = []string{slug}
		svcFilter = svc
	}

	rows := make([]domain.Row, 0)
	failures := make([]domain.Failure, 0)

	for _, slug := range slugs {
		results, err := federation.FanOutServices(ctx, s.fed, slug, federation.ForEndpoint(endpoint), productPath, op)
		if err != nil {
			// slug itself could not be resolved at all — unconfigured, or no
			// service declares this endpoint (ErrProductNotConfigured,
			// ErrNoMatchingService). Degrades this one product exactly the
			// way a per-service failure below degrades one service, never
			// the whole read.
			f := federation.ServiceResult{Err: err}.Failure(slug)
			s.log.ErrorContext(ctx, "emailtemplates: federated source failed",
				"source", slug, "error", f.Error, "cause", f.Unwrap())
			failures = append(failures, domain.Failure{Source: slug, Message: f.Error})
			continue
		}

		for _, r := range results {
			if svcFilter != "" && r.Service != svcFilter {
				// source named one specific service; every other match for
				// this slug is not what was asked for.
				continue
			}
			label := s.sourceLabel(slug, r.Service)

			if r.Err != nil {
				f := r.Failure(label)
				s.log.ErrorContext(ctx, "emailtemplates: federated source failed",
					"source", label, "error", f.Error, "cause", f.Unwrap())
				failures = append(failures, domain.Failure{Source: label, Message: f.Error})
				continue
			}

			var envelope struct {
				Data []domain.Row `json:"data"`
			}
			if err := json.Unmarshal(r.Body, &envelope); err != nil {
				s.log.ErrorContext(ctx, "emailtemplates: federated source failed",
					"source", label, "error", "invalid response",
					"cause", fmt.Errorf("decoding %s email templates: %w", label, err))
				failures = append(failures, domain.Failure{Source: label, Message: "invalid response"})
				continue
			}
			for _, row := range envelope.Data {
				rows = append(rows, stamp(label, row))
			}
		}
	}

	// Source then key, so two identical reads render identically. An unstable
	// order makes a re-read look like a change.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Source != rows[j].Source {
			return rows[i].Source < rows[j].Source
		}
		return rows[i].Key < rows[j].Key
	})
	sort.SliceStable(failures, func(i, j int) bool { return failures[i].Source < failures[j].Source })

	return domain.Page{Templates: rows, Failures: failures}, nil
}

// Get reads one template, bodies included.
func (s *Service) Get(ctx context.Context, op federation.Operator, id string) (domain.Detail, error) {
	slug, svc, key, err := s.split(id)
	if err != nil {
		return domain.Detail{}, err
	}
	if svc == "" {
		svc, err = s.defaultService(slug)
		if err != nil {
			return domain.Detail{}, err
		}
	}

	// GetForService, not GetForEndpoint: this service is already the exact
	// one the id names (explicitly, or resolved to the product's default),
	// so there is no Selector left to resolve and nothing that can go
	// ambiguous — see GetForService's doc comment.
	raw, err := s.fed.GetForService(ctx, slug, svc, productPath+"/"+url.PathEscape(key), op)
	if err != nil {
		// Returned UNWRAPPED so federation.ErrorCode and federation.StatusOf
		// can still read the product's refusal out of it. Wrapping with %w
		// would preserve that; wrapping with %v — the easy mistake — would
		// not, and the code is the only actionable thing a refusal carries.
		return domain.Detail{}, err
	}
	return decodeDetail(s.sourceLabel(slug, svc), raw)
}

// Save upserts one template at the service that owns it.
//
// # It writes no audit row here, and that is the convention rather than an
// omission
//
// §6's rule is that the WRITER audits: whoever performs the mutation records
// it, in the same transaction, and nobody audits a write somebody else
// performed. The product performs this one — mark8ly appends an
// `email_template_revisions` row on the same transaction as the update — so a
// second record written here would be a claim about a write this service does
// not know landed. The tenants module's suspend/unsuspend take the same shape
// and import the audit package nowhere.
//
// The idempotency key is REQUIRED and forwarded, and this service does not
// deduplicate: it has no database on this path, and a second dedup layer over
// another product's write could report a cached success for something the
// owner never applied. See federation.Client.Post for the honest limit on what
// the header buys today.
func (s *Service) Save(
	ctx context.Context, op federation.Operator, id string, in Upsert, idempotencyKey string,
) (domain.Detail, error) {
	slug, svc, key, err := s.split(id)
	if err != nil {
		return domain.Detail{}, err
	}
	if svc == "" {
		svc, err = s.defaultService(slug)
		if err != nil {
			return domain.Detail{}, err
		}
	}

	// Re-marshalled from the decoded struct rather than forwarded as received
	// bytes: what this service accepts is its own contract (§4 rejects unknown
	// fields), and passing the caller's body through would make every future
	// product field a field this service silently accepts today.
	body, err := json.Marshal(in)
	if err != nil {
		return domain.Detail{}, fmt.Errorf("emailtemplates: encoding the save for %s: %w", slug, err)
	}

	// PutForService, not PutForEndpoint — see the same note on Get above: the
	// service is already named, explicitly or via the default, and a write
	// must never guess between services the way a Selector-based resolution
	// could reach ErrAmbiguousService and be tempted to.
	raw, err := s.fed.PutForService(ctx, slug, svc, productPath+"/"+url.PathEscape(key), body, op,
		federation.PostOptions{IdempotencyKey: idempotencyKey})
	if err != nil {
		return domain.Detail{}, err
	}
	return decodeDetail(s.sourceLabel(slug, svc), raw)
}

// TestSend sends one real email through the product's own send path.
//
// It renders whatever is LIVE for the key — a published row if there is one,
// the embedded default otherwise — not the draft in the operator's editor.
// That is the product's decision and the right one: a test that rendered
// unsaved copy would answer a question nobody asked.
func (s *Service) TestSend(
	ctx context.Context, op federation.Operator, id string, in TestSendRequest, idempotencyKey string,
) (domain.TestSend, error) {
	slug, svc, key, err := s.split(id)
	if err != nil {
		return domain.TestSend{}, err
	}
	if svc == "" {
		svc, err = s.defaultService(slug)
		if err != nil {
			return domain.TestSend{}, err
		}
	}

	if in.Vars == nil {
		// `{}` rather than `null`. The product renders with these, and a null
		// map reaching a template engine is a different failure from an empty
		// one on the far side of a JSON hop.
		in.Vars = map[string]any{}
	}
	body, err := json.Marshal(in)
	if err != nil {
		return domain.TestSend{}, fmt.Errorf("emailtemplates: encoding the test send for %s: %w", slug, err)
	}

	// PostForService, not PostForEndpoint — see the same note on Save above.
	if _, err := s.fed.PostForService(ctx, slug, svc,
		productPath+"/"+url.PathEscape(key)+"/test-send", body, op,
		federation.PostOptions{IdempotencyKey: idempotencyKey}); err != nil {
		return domain.TestSend{}, err
	}

	label := s.sourceLabel(slug, svc)
	// Built from what was ASKED, not from the product's echo: the product
	// answers `{key, to, sent}` and re-reading the address out of it would let
	// a buggy product tell an operator their test went somewhere it did not.
	return domain.TestSend{
		ID:     label + idSeparator + key,
		Source: label,
		Key:    key,
		To:     in.To,
		Sent:   true,
	}, nil
}

// defaultService resolves a bare (service-less) source's target service —
// what a `slug:key` id, with no `/service` half, actually addresses.
func (s *Service) defaultService(slug string) (string, error) {
	svc, ok := s.fed.DefaultServiceName(slug)
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrNoDefaultService, slug)
	}
	return svc, nil
}

// split turns `<source>:<key>` into a product this deployment may call —
// with, when the source names one, the specific service — and a key it is
// willing to put in a URL.
//
// source is `<slug>` or `<slug>/<service>` (see serviceSeparator). Both forms
// share the grammar parseSource enforces for a bare `?source=` value, because
// Sources() enumerates exactly these same values and the two must never
// disagree on what one means. svc is returned empty for the bare form — NOT
// resolved to a default here, so a caller (Get/Save/TestSend) that wants the
// default must ask for it explicitly via defaultService, keeping split a pure
// parse with no federation lookups beyond the registry-only checks
// parseSource already makes.
func (s *Service) split(id string) (slug, svc, key string, err error) {
	if len(s.slugs) == 0 {
		return "", "", "", ErrNotInstrumented
	}
	at := strings.Index(id, idSeparator)
	if at <= 0 || at == len(id)-1 {
		// A bare key names no product. Refused rather than guessed at: guessing
		// means choosing a product to write to, and there is no safe default
		// for that — least of all once a second source holds the same keys.
		return "", "", "", fmt.Errorf(
			"%w: %q names no product — ids on this surface are <source>:<key>", ErrMalformedID, id)
	}
	source, key := id[:at], id[at+1:]

	slug, svc, err = s.parseSource(source)
	if err != nil {
		return "", "", "", err
	}
	if !keyPattern.MatchString(key) {
		return "", "", "", fmt.Errorf("%w: %q is not a template key", ErrMalformedID, key)
	}
	return slug, svc, key, nil
}

// parseSource turns a `source` value — `<slug>` or `<slug>/<service>` — into
// a product this deployment may call and, when given, the specific service
// named. Shared by split (an id's source half) and List (the `?source=`
// query parameter) so the two agree byte-for-byte on the grammar.
//
// A malformed or unknown service NEVER reaches the network here: the service
// check is against federation.Client.ServiceNamesFor, a pure registry lookup
// (see its doc comment), not a call to the product — a caller naming an
// unknown service must error exactly as fast as one naming an unknown
// product, and neither may pick a service by guessing.
func (s *Service) parseSource(source string) (slug, svc string, err error) {
	slug, svc = source, ""
	if at := strings.Index(source, serviceSeparator); at >= 0 {
		if at == 0 || at == len(source)-1 {
			return "", "", fmt.Errorf(
				"%w: %q is not a valid source — expected <slug> or <slug>/<service>", ErrMalformedID, source)
		}
		slug, svc = source[:at], source[at+1:]
	}
	if !contains(s.slugs, slug) {
		return "", "", fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}
	if svc != "" && !contains(s.fed.ServiceNamesFor(slug, endpoint), svc) {
		return "", "", fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}
	return slug, svc, nil
}

// decodeDetail reads the product's single-template envelope.
func decodeDetail(source string, raw []byte) (domain.Detail, error) {
	var envelope struct {
		Data domain.Detail `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return domain.Detail{}, fmt.Errorf("emailtemplates: decoding the %s template: %w", source, err)
	}
	detail := envelope.Data
	detail.Row = stamp(source, detail.Row)
	if detail.Variables == nil {
		detail.Variables = []domain.Variable{}
	}
	return detail, nil
}

// stamp attaches the source and the namespaced id.
//
// source is a full `source` value — a bare slug or `slug/service` — never
// read from the body: a product cannot name itself into another source's
// registry, and it cannot namespace its keys into another source's either.
func stamp(source string, row domain.Row) domain.Row {
	row.Source = source
	row.ID = source + idSeparator + row.Key
	return row
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
