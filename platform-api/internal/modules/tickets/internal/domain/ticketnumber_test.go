package domain_test

import (
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// The prefix map is a CONTRACT with tickets that already exist, not a
// formatting preference. Every M8-0001 in tesserix_admin was written by
// apps/web's PRODUCT_PREFIX table, and a ticket number is what a merchant
// quotes back in an email — so a product whose prefix changed on migration
// would have two numbering schemes for one queue.
//
// mark8ly -> M8 is the case that makes the map non-negotiable: it is NOT the
// first two letters, so no derivation reproduces it.

func TestTheKnownProductsKeepTheirExistingPrefixes(t *testing.T) {
	for product, want := range map[string]string{
		"mark8ly":  "M8",
		"homechef": "HC",
		"fanzone":  "FZ",
	} {
		if got := domain.TicketNumberPrefix(product); got != want {
			t.Errorf("TicketNumberPrefix(%q) = %q, want %q — this renumbers a live queue", product, got, want)
		}
	}
}

func TestAnUnknownProductFallsBackToTwoUppercaseLetters(t *testing.T) {
	// apps/web's fallback, reproduced exactly: `productId.slice(0,2).toUpperCase()`.
	if got := domain.TicketNumberPrefix("kora"); got != "KO" {
		t.Errorf("TicketNumberPrefix(kora) = %q, want KO", got)
	}
}

func TestAShortProductNameDoesNotPanic(t *testing.T) {
	// JavaScript's slice(0,2) on a 1-character string returns that character
	// rather than throwing. Go's [:2] would panic, which would turn a silly
	// product slug into a 500 on ticket creation.
	if got := domain.TicketNumberPrefix("k"); got != "K" {
		t.Errorf("TicketNumberPrefix(k) = %q, want K", got)
	}
	if got := domain.TicketNumberPrefix(""); got != "" {
		t.Errorf("TicketNumberPrefix(\"\") = %q, want empty", got)
	}
}

func TestTheNumberIsZeroPaddedToFourDigits(t *testing.T) {
	// `String(n).padStart(4, "0")`. A merchant reads these; M8-0001 and M8-1
	// are not the same reference.
	for _, tc := range []struct {
		n    int64
		want string
	}{
		{1, "M8-0001"},
		{42, "M8-0042"},
		{9999, "M8-9999"},
		{10000, "M8-10000"}, // padStart does not truncate past the width
	} {
		if got := domain.TicketNumber("mark8ly", tc.n); got != tc.want {
			t.Errorf("TicketNumber(mark8ly, %d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}
