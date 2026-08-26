package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Lifecycle is the reason a tenant's state is being changed.
//
// ReasonCode is passed THROUGH to the product rather than validated here.
// mark8ly declares its own sets — seven codes for suspend, four for unsuspend,
// and deliberately different ones — and a copy of that vocabulary in this
// module would be a second list that drifts from the first. The product
// refuses an unknown code with §4.4's `invalid_reason_code`, which this
// package surfaces, so the operator still learns what was wrong. The same
// argument the tenant `Status` field makes for rendering verbatim.
type Lifecycle struct {
	ReasonCode string `json:"reason_code"`
	Reason     string `json:"reason,omitempty"`
}

// LifecycleResult is what the product reports it did.
//
// Changed is the field that matters and the one a caller must not infer:
// suspending an already-suspended tenant is a legitimate no-op, and reporting
// it as a fresh suspension would put a false entry in an operator's head and,
// worse, in the audit trail they read afterwards.
type LifecycleResult struct {
	TenantID       string `json:"tenant_id"`
	Status         string `json:"status"`
	StoresAffected int    `json:"stores_affected"`
	Changed        bool   `json:"changed"`
}

// Suspend suspends one tenant at the product that owns it.
func (s *Service) Suspend(
	ctx context.Context, op federation.Operator,
	tenantID string, in Lifecycle, idempotencyKey string,
) (LifecycleResult, error) {
	return s.lifecycle(ctx, op, tenantID, "suspend", in, idempotencyKey)
}

// Unsuspend reverses a suspension.
func (s *Service) Unsuspend(
	ctx context.Context, op federation.Operator,
	tenantID string, in Lifecycle, idempotencyKey string,
) (LifecycleResult, error) {
	return s.lifecycle(ctx, op, tenantID, "unsuspend", in, idempotencyKey)
}

// lifecycle is the shared path. Both verbs differ only in the segment.
//
// NOTE ON IDEMPOTENCY, because assuming more than is true here would be
// expensive: this service forwards the caller's key and does NOT deduplicate.
// It has no database, and a second dedup layer over another product's writes
// could disagree with the product's own — reporting a cached success for
// something the owner never applied. The product is the system of record for
// its tenants. On mark8ly today only /admin/billing/trials/{id}/extend
// actually honours the header; suspend and unsuspend accept and ignore it. So
// the key is necessary, forwarded, and not yet sufficient — see Client.Post.
func (s *Service) lifecycle(
	ctx context.Context, op federation.Operator,
	tenantID, verb string, in Lifecycle, idempotencyKey string,
) (LifecycleResult, error) {
	slug, productID, ok := splitTenantID(tenantID)
	if !ok {
		// A bare id names no product. Refused rather than guessed at: guessing
		// means choosing a product to mutate, and there is no safe default for
		// that.
		return LifecycleResult{}, fmt.Errorf(
			"%w: %q names no product — ids on this surface are <source>:<id>", ErrUnknownSource, tenantID)
	}
	if !contains(s.slugs, slug) {
		return LifecycleResult{}, fmt.Errorf("%w: %s", ErrUnknownSource, slug)
	}

	body, err := json.Marshal(in)
	if err != nil {
		return LifecycleResult{}, fmt.Errorf("tenants: encoding %s request: %w", verb, err)
	}

	raw, err := s.fed.Post(ctx, slug,
		"/admin/tenants/"+productID+"/"+verb, body, op,
		federation.PostOptions{IdempotencyKey: idempotencyKey})
	if err != nil {
		// Returned unwrapped so federation.ErrorCode can still read the
		// product's §4.4 code out of it. Wrapping with %w would preserve that,
		// but wrapping with %v — the easy mistake — would not, and the code is
		// the only actionable thing a refusal carries.
		return LifecycleResult{}, err
	}

	var envelope struct {
		Data LifecycleResult `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return LifecycleResult{}, fmt.Errorf("tenants: decoding %s result from %s: %w", verb, slug, err)
	}
	return envelope.Data, nil
}

// splitTenantID splits a namespaced id into the product and its own id.
//
// On the FIRST separator only: a product's own id may contain a colon, and
// splitting on the last would send the wrong path to the right product — a
// mutation aimed at something else.
func splitTenantID(id string) (slug, productID string, ok bool) {
	at := strings.Index(id, idSeparator)
	if at <= 0 || at == len(id)-1 {
		return "", "", false
	}
	return id[:at], id[at+1:], true
}
