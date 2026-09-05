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

// idSeparator namespaces a key with the product that owns it. See domain.Row.
const idSeparator = ":"

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
	// ErrUnknownSource names a product this deployment cannot call. Refused
	// rather than answered empty, so a typo does not read as "that product has
	// no templates".
	ErrUnknownSource = errors.New("emailtemplates: unknown source")
	// ErrMalformedID is an id that names no product, or whose key is not one
	// this surface will put in a URL.
	ErrMalformedID = errors.New("emailtemplates: malformed template id")
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

// New builds the service. slugs is every product declaring `email-templates`.
// log receives one ERROR line per federation failure carrying the unredacted
// cause — the wire-facing domain.Failure is a coarse, closed-set string, so
// without this line a production outage is undiagnosable.
func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Sources is the products this deployment can ask, in a stable order.
func (s *Service) Sources() []string { return s.slugs }

// List merges every configured product's registry, or one named by source.
//
// There is no pagination and no limit, unlike every other fan-out in this
// service. The key set is CLOSED and owned by code — a key exists because a Go
// call site renders it — so it is a few dozen entries per product that cannot
// grow at runtime. A limit parameter over a fixed set would be furniture, and
// a console would build paging controls for a page that can never have a
// second one. The federation client's 1 MiB read limit is the only bound, and
// bodies are deliberately not in this shape so it is nowhere near reached.
func (s *Service) List(ctx context.Context, op federation.Operator, source string) (domain.Page, error) {
	if len(s.slugs) == 0 {
		// Checked before the source filter: with nothing configured every
		// source is unknown, and "you asked for a product that does not exist"
		// is a misleading way to say "this deployment federates no registry".
		return domain.Page{}, ErrNotInstrumented
	}

	slugs := s.slugs
	if source != "" {
		if !contains(s.slugs, source) {
			return domain.Page{}, fmt.Errorf("%w: %s", ErrUnknownSource, source)
		}
		slugs = []string{source}
	}

	rows, failures := federation.FanOut(ctx, s.fed, slugs, productPath, op,
		func(slug string, body []byte) ([]domain.Row, error) {
			var envelope struct {
				Data []domain.Row `json:"data"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				return nil, fmt.Errorf("decoding %s email templates: %w", slug, err)
			}
			out := make([]domain.Row, 0, len(envelope.Data))
			for _, row := range envelope.Data {
				out = append(out, stamp(slug, row))
			}
			return out, nil
		})

	// Logged over the federation.Failure values, before mapping to the domain
	// shape: federation.Failure carries the unredacted cause via Unwrap and
	// domain.Failure deliberately does not — it is what reaches a browser.
	for _, f := range failures {
		s.log.ErrorContext(ctx, "emailtemplates: federated source failed",
			"source", f.Product, "error", f.Error, "cause", f.Unwrap())
	}

	// Source then key, so two identical reads render identically. An unstable
	// order makes a re-read look like a change.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Source != rows[j].Source {
			return rows[i].Source < rows[j].Source
		}
		return rows[i].Key < rows[j].Key
	})

	page := domain.Page{Templates: rows, Failures: make([]domain.Failure, 0, len(failures))}
	for _, f := range failures {
		page.Failures = append(page.Failures, domain.Failure{Source: f.Product, Message: f.Error})
	}
	return page, nil
}

// Get reads one template, bodies included.
func (s *Service) Get(ctx context.Context, op federation.Operator, id string) (domain.Detail, error) {
	slug, key, err := s.split(id)
	if err != nil {
		return domain.Detail{}, err
	}

	raw, err := s.fed.Get(ctx, slug, productPath+"/"+url.PathEscape(key), op)
	if err != nil {
		// Returned UNWRAPPED so federation.ErrorCode and federation.StatusOf
		// can still read the product's refusal out of it. Wrapping with %w
		// would preserve that; wrapping with %v — the easy mistake — would
		// not, and the code is the only actionable thing a refusal carries.
		return domain.Detail{}, err
	}
	return decodeDetail(slug, raw)
}

// Save upserts one template at the product that owns it.
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
	slug, key, err := s.split(id)
	if err != nil {
		return domain.Detail{}, err
	}

	// Re-marshalled from the decoded struct rather than forwarded as received
	// bytes: what this service accepts is its own contract (§4 rejects unknown
	// fields), and passing the caller's body through would make every future
	// product field a field this service silently accepts today.
	body, err := json.Marshal(in)
	if err != nil {
		return domain.Detail{}, fmt.Errorf("emailtemplates: encoding the save for %s: %w", slug, err)
	}

	raw, err := s.fed.Put(ctx, slug, productPath+"/"+url.PathEscape(key), body, op,
		federation.PostOptions{IdempotencyKey: idempotencyKey})
	if err != nil {
		return domain.Detail{}, err
	}
	return decodeDetail(slug, raw)
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
	slug, key, err := s.split(id)
	if err != nil {
		return domain.TestSend{}, err
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

	if _, err := s.fed.Post(ctx, slug,
		productPath+"/"+url.PathEscape(key)+"/test-send", body, op,
		federation.PostOptions{IdempotencyKey: idempotencyKey}); err != nil {
		return domain.TestSend{}, err
	}

	// Built from what was ASKED, not from the product's echo: the product
	// answers `{key, to, sent}` and re-reading the address out of it would let
	// a buggy product tell an operator their test went somewhere it did not.
	return domain.TestSend{
		ID:     slug + idSeparator + key,
		Source: slug,
		Key:    key,
		To:     in.To,
		Sent:   true,
	}, nil
}

// split turns `<source>:<key>` into a product this deployment may call and a
// key it is willing to put in a URL.
func (s *Service) split(id string) (slug, key string, err error) {
	if len(s.slugs) == 0 {
		return "", "", ErrNotInstrumented
	}
	at := strings.Index(id, idSeparator)
	if at <= 0 || at == len(id)-1 {
		// A bare key names no product. Refused rather than guessed at: guessing
		// means choosing a product to write to, and there is no safe default
		// for that — least of all once a second source holds the same keys.
		return "", "", fmt.Errorf(
			"%w: %q names no product — ids on this surface are <source>:<key>", ErrMalformedID, id)
	}
	slug, key = id[:at], id[at+1:]
	if !contains(s.slugs, slug) {
		return "", "", fmt.Errorf("%w: %s", ErrUnknownSource, slug)
	}
	if !keyPattern.MatchString(key) {
		return "", "", fmt.Errorf("%w: %q is not a template key", ErrMalformedID, key)
	}
	return slug, key, nil
}

// decodeDetail reads the product's single-template envelope.
func decodeDetail(slug string, raw []byte) (domain.Detail, error) {
	var envelope struct {
		Data domain.Detail `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return domain.Detail{}, fmt.Errorf("emailtemplates: decoding the %s template: %w", slug, err)
	}
	detail := envelope.Data
	detail.Row = stamp(slug, detail.Row)
	if detail.Variables == nil {
		detail.Variables = []domain.Variable{}
	}
	return detail, nil
}

// stamp attaches the source and the namespaced id.
//
// Both from the slug the call was MADE to, never from the body: a product
// cannot name itself into another product's registry, and it cannot namespace
// its keys into another product's either.
func stamp(slug string, row domain.Row) domain.Row {
	row.Source = slug
	row.ID = slug + idSeparator + row.Key
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
