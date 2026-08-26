// Package service reads one product's headline metrics.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// productPath is contract §3.1, as amended by §8.6 — the metrics map is
// wrapped in `data`.
const productPath = "/admin/kpis"

// ErrNotInstrumented is a product SAYING it reports no metrics.
//
// This is the whole reason this module is more than a passthrough. §3.1 is
// explicit that a product with no metrics answers 501 rather than 200 with an
// empty map, so the console can render "not instrumented" instead of dashes
// that look like zeroes — dwellm8 rendered four em-dashes from launch for
// exactly that reason.
//
// Kora answers 501 today ("kora does not report business KPIs yet"), so this
// path is not hypothetical: it is the live behaviour of a real product.
var ErrNotInstrumented = errors.New("kpis: the product reports no metrics")

// ErrUnknownSource is a filter naming a product this deployment cannot call.
var ErrUnknownSource = errors.New("kpis: unknown source")

// ErrNoProducts is the answer when this deployment federates nothing at all.
// Distinct from ErrNotInstrumented: "no product is configured" and "this
// product has no metrics" are different facts with different fixes.
var ErrNoProducts = errors.New("kpis: no products are configured")

// Service reads a product's KPI map.
type Service struct {
	fed   *federation.Client
	slugs []string
	log   *slog.Logger
}

func New(fed *federation.Client, slugs []string, log *slog.Logger) *Service {
	return &Service{fed: fed, slugs: slugs, log: log}
}

// Metrics is one product's flat map of headline numbers.
//
// `any` rather than float64: §3.1 says scalars, and a product may legitimately
// report a string ("healthy") or a bool beside its numbers. Narrowing here
// would drop a metric the product meant to send, and the console renders what
// it is given.
type Metrics map[string]any

// Read fetches one product's metrics.
//
// # There is no fan-out, deliberately
//
// Every other federated read in this service merges across products. Merging
// KPIs is meaningless: two products' `orders_today` are different numbers
// about different businesses, and summing or interleaving them produces a
// figure that describes nothing. §8.5's test — can two products' rows sit in
// one table without a column meaning something different in each? — fails
// here, which is why the overview backed by this is a product-rail surface.
func (s *Service) Read(ctx context.Context, op federation.Operator, source string) (Metrics, error) {
	if len(s.slugs) == 0 {
		return nil, ErrNoProducts
	}
	if !contains(s.slugs, source) {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}

	body, err := s.fed.Get(ctx, source, productPath, op)
	if err != nil {
		// THE branch this module exists for. A product answering 501 is making
		// a contract statement, not failing — and 404 says the same thing one
		// level cruder: the route is not mounted, so the product implements no
		// KPIs. Both become ErrNotInstrumented, which the handler renders as
		// 501 so the console's `instrumentation-unavailable` state fires
		// rather than an error page.
		//
		// Everything else — 5xx, DNS, TLS, timeout — is a product failing to
		// answer, and must NOT be reported as "not instrumented". That would
		// tell an operator a metric does not exist when it exists and is
		// unreachable, which is the more dangerous of the two mistakes.
		if status, ok := federation.StatusOf(err); ok &&
			(status == http.StatusNotImplemented || status == http.StatusNotFound) {
			return nil, fmt.Errorf("%w: %s", ErrNotInstrumented, source)
		}
		s.log.Error("kpis: federated read failed", "source", source, "error", err)
		return nil, fmt.Errorf("reading %s kpis: %w", source, err)
	}

	// §8.6's amendment: the map is wrapped in `data`. Before it, §3.1
	// specified a bare map at the top level — decoding that shape here would
	// yield an empty map for a product still serving it, which is
	// indistinguishable from real zeroes. So a missing `data` is an error, not
	// an empty result.
	var envelope struct {
		Data Metrics `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("decoding %s kpis: %w", source, err)
	}
	if envelope.Data == nil {
		return nil, fmt.Errorf("decoding %s kpis: no data object (§8.6 wraps the metrics map)", source)
	}
	// An EMPTY map is refused rather than passed on. §3.1 is explicit that a
	// product with no metrics answers 501 and must not return `{}` — `{}` is
	// indistinguishable from every metric being zero, which is the exact
	// failure the status code exists to prevent. A product sending it is
	// deviating, and reporting that as "not instrumented" would hide the
	// deviation behind a legitimate-looking answer.
	if len(envelope.Data) == 0 {
		return nil, fmt.Errorf("decoding %s kpis: empty metrics map — §3.1 requires 501 not_implemented instead", source)
	}
	return envelope.Data, nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
