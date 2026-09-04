package domain

import (
	"fmt"
	"strings"
)

// prefixes are the ticket-number prefixes already in use.
//
// A TABLE, not a derivation, because it is a contract with rows that already
// exist: every M8-0001 in tesserix_admin was written by PRODUCT_PREFIX in
// apps/web/lib/db/platform-tickets.ts, and a merchant quotes a ticket number
// back in an email. A product whose prefix changed on migration would have two
// numbering schemes for one queue.
//
// mark8ly -> M8 is what makes this non-negotiable: it is not the first two
// letters of the slug, so no rule reproduces it. Copied deliberately rather
// than "tidied".
var prefixes = map[string]string{
	"mark8ly":  "M8",
	"homechef": "HC",
	"fanzone":  "FZ",
}

// TicketNumberPrefix returns the prefix a product's ticket numbers carry.
//
// The fallback for an unregistered product is the first two characters
// uppercased, matching `productId.slice(0, 2).toUpperCase()`. Reproduced by
// RUNE rather than by byte, and bounded by length: Go's s[:2] panics on a
// one-character slug where JavaScript's slice quietly returns it, and a silly
// product name should not be a 500 on ticket creation.
func TicketNumberPrefix(product string) string {
	if p, ok := prefixes[product]; ok {
		return p
	}
	runes := []rune(product)
	if len(runes) > 2 {
		runes = runes[:2]
	}
	return strings.ToUpper(string(runes))
}

// TicketNumber renders the human reference for a ticket.
//
// Zero-padded to four digits and NOT truncated beyond it, matching
// `padStart(4, "0")`: the ten-thousandth ticket is M8-10000, not M8-0000.
func TicketNumber(product string, n int64) string {
	return fmt.Sprintf("%s-%04d", TicketNumberPrefix(product), n)
}
