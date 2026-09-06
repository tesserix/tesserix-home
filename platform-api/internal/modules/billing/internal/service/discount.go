package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// idSeparator namespaces a tenant's id with the product that owns it, the same
// way the tenants module does — the console addresses tenants as
// `<source>:<id>` on every surface.
const idSeparator = ":"

// discountPath is the product's path for the write, before the verb's segment.
const discountPath = "/admin/billing/tenants/"

// ApplyDiscount puts a platform coupon on every store one tenant owns.
func (s *Service) ApplyDiscount(
	ctx context.Context, op federation.Operator,
	tenantID string, in domain.DiscountRequest, idempotencyKey string,
) (domain.DiscountResult, error) {
	return s.discount(ctx, op, tenantID, "apply", in, idempotencyKey)
}

// RemoveDiscount takes that coupon back off.
func (s *Service) RemoveDiscount(
	ctx context.Context, op federation.Operator,
	tenantID string, in domain.DiscountRequest, idempotencyKey string,
) (domain.DiscountResult, error) {
	return s.discount(ctx, op, tenantID, "remove", in, idempotencyKey)
}

// discount is the shared path. Both verbs differ only in the trailing segment.
//
// A TARGETED write to the one product that owns the tenant, so it does not use
// federation.FanOut like every read in this package: writing the same body to
// several products has no honest representation of a partial failure, which is
// the argument Client.Post's own docstring makes for not exposing it there.
//
// NOTE ON IDEMPOTENCY: this service forwards the caller's key and does not
// deduplicate — it has no database, and the product is the system of record.
// Here the forwarding is more than a gesture: mark8ly's handler Reserves the
// key before the fan-out and replays the stored report verbatim, scoped
// `tenant_discount:<op>:<tenant>:<key>`, so a key reused across apply and
// remove cannot replay the other verb's report.
func (s *Service) discount(
	ctx context.Context, op federation.Operator,
	tenantID, operation string, in domain.DiscountRequest, idempotencyKey string,
) (domain.DiscountResult, error) {
	slug, productID, ok := splitTenantID(tenantID)
	if !ok {
		// A bare id names no product. Refused rather than guessed at: guessing
		// means choosing whose billing to change, and there is no safe default
		// for that.
		return domain.DiscountResult{}, fmt.Errorf(
			"%w: %q names no product — ids on this surface are <source>:<id>", ErrUnknownSource, tenantID)
	}
	if !contains(s.slugs, slug) {
		return domain.DiscountResult{}, fmt.Errorf("%w: %s", ErrUnknownSource, slug)
	}

	body, err := json.Marshal(in)
	if err != nil {
		return domain.DiscountResult{}, fmt.Errorf("billing: encoding the %s discount request: %w", operation, err)
	}

	// The BARE product id. mark8ly's handler parses this segment with
	// uuid.Parse and answers `invalid_tenant_id` for anything else, so the
	// namespace is stripped here rather than passed on.
	path := discountPath + productID + "/discount"
	if operation == "remove" {
		// POST .../discount/remove and not DELETE .../discount: both verbs
		// carry a body, the request is HMAC-signed over a hash of that body,
		// and an intermediary is permitted to drop a DELETE's — which would
		// surface as a 401 and read as an authentication fault. mark8ly#772
		// made the same change on its side for the same reason.
		path += "/remove"
	}

	raw, err := s.fed.Post(ctx, slug, path, body, op,
		federation.PostOptions{IdempotencyKey: idempotencyKey})
	if err != nil {
		// Returned unwrapped so federation.ErrorCode can still read the
		// product's §4.4 code out of it. Wrapping with %w would preserve that,
		// but wrapping with %v — the easy mistake — would not, and the code is
		// the only actionable thing a refusal carries.
		return domain.DiscountResult{}, err
	}

	return s.project(slug, operation, raw)
}

// project turns the product's report into this surface's own, field by field.
//
// The body is decoded WITHOUT a `data` envelope, unlike every other federated
// call in this service. That is mark8ly's shape and it was read rather than
// assumed: its handler answers `c.JSON(http.StatusOK, resp)` with the report
// itself, where the tenant lifecycle endpoints beside it answer
// `gin.H{"data": ...}`. Decoding an envelope here would silently produce an
// empty report from a perfectly good response.
func (s *Service) project(slug, operation string, raw []byte) (domain.DiscountResult, error) {
	var wire struct {
		TenantID               string `json:"tenant_id"`
		CouponID               string `json:"coupon_id"`
		PerformedAt            string `json:"performed_at"`
		Status                 string `json:"status"`
		RequiresReconciliation bool   `json:"requires_reconciliation"`
		Stores                 []struct {
			StoreID              string `json:"store_id"`
			SubscriptionID       string `json:"subscription_id"`
			StripeCustomerID     string `json:"stripe_customer_id"`
			StripeSubscriptionID string `json:"stripe_subscription_id"`
			Outcome              string `json:"outcome"`
			FailureCode          string `json:"failure_code"`
			FailureReason        string `json:"failure_reason"`
		} `json:"stores"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return domain.DiscountResult{}, fmt.Errorf(
			"billing: decoding the %s discount result from %s: %w", operation, slug, err)
	}

	status := domain.ParseDiscountStatus(wire.Status)
	if status == domain.DiscountStatusUnknown {
		s.log.Error("billing: discount report carried an unrecognised status",
			"source", slug, "operation", operation, "status", wire.Status)
	}

	stores := make([]domain.DiscountStore, 0, len(wire.Stores))
	for _, store := range wire.Stores {
		outcome := domain.ParseStoreOutcome(store.Outcome)
		if outcome == domain.StoreOutcomeUnknown {
			// Logged with the value it replaced, because the named unknown
			// that reaches the console deliberately does not carry it.
			s.log.Error("billing: discount report carried an unrecognised store outcome",
				"source", slug, "operation", operation, "store", store.StoreID, "outcome", store.Outcome)
		}
		stores = append(stores, domain.DiscountStore{
			StoreID:              store.StoreID,
			Outcome:              outcome,
			SubscriptionID:       store.SubscriptionID,
			StripeCustomerID:     store.StripeCustomerID,
			StripeSubscriptionID: store.StripeSubscriptionID,
			FailureCode:          store.FailureCode,
			FailureReason:        store.FailureReason,
		})
	}

	return domain.DiscountResult{
		// Stamped from the slug the call was MADE to and the verb this service
		// invoked — never from the body, so a product cannot report an apply
		// as a remove or name itself into another product's billing.
		Source:                 slug,
		Operation:              operation,
		TenantID:               wire.TenantID,
		CouponID:               wire.CouponID,
		PerformedAt:            wire.PerformedAt,
		Status:                 status,
		RequiresReconciliation: wire.RequiresReconciliation,
		Stores:                 stores,
	}, nil
}

// splitTenantID splits a namespaced id into the product and its own id.
//
// On the FIRST separator only: a product's own id may contain a colon, and
// splitting on the last would send the wrong path to the right product — a
// mutation aimed at something else. The tenants module splits the same way for
// the same reason.
func splitTenantID(id string) (slug, productID string, ok bool) {
	at := strings.Index(id, idSeparator)
	if at <= 0 || at == len(id)-1 {
		return "", "", false
	}
	return id[:at], id[at+1:], true
}

// contains reports whether this deployment may call the named product.
func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}
