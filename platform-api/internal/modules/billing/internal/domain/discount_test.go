package domain_test

import (
	"encoding/json"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/domain"
)

// Every outcome mark8ly's tenantdiscount package declares, copied from
// services/marketplace-api/internal/billing/tenantdiscount/outcome.go. Nine of
// them, including the two the fan-out itself never produces — ApplyToNewSubscription
// emits `no_override`, and a newer mark8ly could route one through this surface.
func TestEveryOutcomeMark8lyDeclaresIsRecognised(t *testing.T) {
	for _, raw := range []string{
		"applied", "already_applied", "removed", "not_applied",
		"pending", "no_override", "no_subscription", "no_stripe_customer", "failed",
	} {
		got := domain.ParseStoreOutcome(raw)
		if string(got) != raw {
			t.Errorf("ParseStoreOutcome(%q) = %q, want it recognised verbatim", raw, got)
		}
	}
}

// The reason the type exists: a value this build has never heard of must not
// arrive at the console as an empty string, which renders as though the store
// had no outcome at all.
func TestAnUnrecognisedOutcomeBecomesANamedUnknown(t *testing.T) {
	for _, raw := range []string{"", "invoiced_later", "APPLIED"} {
		if got := domain.ParseStoreOutcome(raw); got != domain.StoreOutcomeUnknown {
			t.Errorf("ParseStoreOutcome(%q) = %q, want the named unknown", raw, got)
		}
	}
}

func TestEveryStatusMark8lyDeclaresIsRecognised(t *testing.T) {
	for _, raw := range []string{"ok", "partial", "failed"} {
		if got := domain.ParseDiscountStatus(raw); string(got) != raw {
			t.Errorf("ParseDiscountStatus(%q) = %q, want it recognised verbatim", raw, got)
		}
	}
}

func TestAnUnrecognisedStatusBecomesANamedUnknown(t *testing.T) {
	if got := domain.ParseDiscountStatus("mostly"); got != domain.DiscountStatusUnknown {
		t.Errorf("ParseDiscountStatus(\"mostly\") = %q, want the named unknown", got)
	}
}

// `requires_reconciliation` is a FIRST-CLASS field on this surface, not
// omitempty as mark8ly serves it. A console that has to distinguish "false"
// from "absent" to know whether a billing arrangement diverged is one that
// will get it wrong.
func TestRequiresReconciliationIsAlwaysPresent(t *testing.T) {
	out, err := json.Marshal(domain.DiscountResult{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(out, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := fields["requires_reconciliation"]; !ok {
		t.Errorf("requires_reconciliation is absent from %s", out)
	}
}

// The operator's own `reason` is deliberately NOT echoed back. It is the
// caller's input, and this surface does not hand a caller their own words back
// as though they were a fact the product reported.
func TestTheResultDoesNotEchoTheCallersReason(t *testing.T) {
	out, err := json.Marshal(domain.DiscountResult{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(out, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := fields["reason"]; ok {
		t.Errorf("reason is echoed back to the caller who sent it: %s", out)
	}
}
