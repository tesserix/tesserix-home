package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// reasonCodesPath is contract §8.8.
const reasonCodesPath = "/admin/lifecycle/reason-codes"

// ErrNoReasonCodes is a product answering §8.8 with nothing in it.
//
// Surfaced rather than passed through as an empty map, because an empty menu
// is the failure this endpoint exists to prevent. §8.3 makes the reason code
// REQUIRED on a suspension, so a form offering no options cannot complete a
// write; rendering it would put an operator in front of a control that looks
// available and is not. A loud gap is the only honest rendering.
var ErrNoReasonCodes = errors.New("tenants: the product declared no lifecycle reason codes")

// ReasonCode is one entry of a product's lifecycle vocabulary.
//
// Carried through verbatim. The Code is the product's wire value and is
// matched exactly by the product's own validator; the Label is the product's
// words. Neither is this service's to normalise — a "helpful" rewrite here is
// how a second vocabulary is born, which is the whole reason §8.8 exists.
type ReasonCode struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}

// ReasonCodes fetches one product's lifecycle vocabulary.
//
// # Why the product is REQUIRED and there is no fan-out
//
// Every other read in this module federates across products and merges. This
// one must not, and the reason is the same one that made #345 worth fixing:
// the vocabularies are per-product and deliberately unequal. Merging mark8ly's
// seven suspend codes with another product's would produce a menu from which
// an operator could pick a code the owning product will refuse — or worse, one
// that both accept and mean differently. An unknown source is refused for the
// same reason the directory refuses one, only with more at stake, because this
// answer becomes the options on a write form.
func (s *Service) ReasonCodes(
	ctx context.Context, op federation.Operator, source string,
) (map[string][]ReasonCode, error) {
	if len(s.slugs) == 0 {
		return nil, ErrNotInstrumented
	}
	if !contains(s.slugs, source) {
		return nil, fmt.Errorf("%w: %s", ErrUnknownSource, source)
	}

	body, err := s.fed.Get(ctx, source, reasonCodesPath, op)
	if err != nil {
		// Not logged here: the caller logs with the source and the operator,
		// and a second line would double-report one failure.
		return nil, fmt.Errorf("reading %s reason codes: %w", source, err)
	}

	var envelope struct {
		Data map[string][]ReasonCode `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("decoding %s reason codes: %w", source, err)
	}
	if len(envelope.Data) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNoReasonCodes, source)
	}

	// Verbs with no codes are dropped rather than passed on as empty arrays.
	// An empty array renders as an empty menu — the silent failure again — and
	// an ABSENT verb is what the console already knows how to render as a gap.
	out := make(map[string][]ReasonCode, len(envelope.Data))
	for verb, codes := range envelope.Data {
		if len(codes) > 0 {
			out[verb] = codes
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNoReasonCodes, source)
	}
	return out, nil
}
