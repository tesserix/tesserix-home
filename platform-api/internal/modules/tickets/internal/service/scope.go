package service

import (
	"fmt"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/repository"
)

// Scope is the product a caller is confined to.
//
// # Why this exists
//
// Until #152 the module had no notion of a caller's reach. `product` and
// `tenant` were query PARAMETERS, `Detail` took a bare id, and `Summary`
// counted the estate — which was correct while the only caller was the console
// and the only principal an operator, who is entitled to all of it.
//
// A product's machine is a different trust class. mark8ly must reach its own
// merchants' tickets and nothing else, and a filter it supplies itself cannot
// be what confines it: that is a suggestion, not a boundary.
//
// # Where the value comes from, and where it must NOT come from
//
// From productscope.Registry — deployment configuration keyed by the subject
// the issuer attests. NOT from the request, NOT from the capability (they are
// estate-wide, §7), and NOT from Principal.Kind, which platform-auth forbids
// authorising on so that caller classification cannot silently become caller
// access (#450, #433).
//
// # The zero value
//
// EMPTY MEANS UNSCOPED — the estate — because the operator path must keep
// behaving exactly as it did, and an operator has no product. This is the one
// place where a zero value grants rather than withholds, so every construction
// site is responsible for not producing one by accident. The handler does that
// by refusing a machine that holds product-support and resolves to no product,
// rather than falling through to Scope{}.
type Scope struct {
	ProductID string
}

// Unscoped reports whether this scope confines nothing.
func (s Scope) Unscoped() bool { return s.ProductID == "" }

// Admits reports whether a ticket belonging to productID is visible here.
//
// The test is "equal to mine", never "not obviously someone else's": a ticket
// carrying no product is refused by a scoped caller rather than admitted for
// matching nothing.
func (s Scope) Admits(productID string) bool {
	if s.Unscoped() {
		return true
	}
	return productID != "" && productID == s.ProductID
}

// Apply confines a filter to this scope, returning a new one.
//
// A filter naming a DIFFERENT product is refused rather than rewritten.
// Rewriting would answer a question about Kora's queue with mark8ly's rows —
// a response that misrepresents the request, which is worse for the caller and
// no safer for anyone else.
//
// A filter naming the caller's OWN product is accepted unchanged, because that
// is what mark8ly's client sends today (`?product=mark8ly`) and this must not
// break it.
func (s Scope) Apply(f repository.Filter) (repository.Filter, error) {
	if s.Unscoped() {
		return f, nil
	}
	if f.Product != "" && f.Product != s.ProductID {
		return repository.Filter{}, fmt.Errorf(
			"%w: this caller may only read %s tickets", ErrRefused, s.ProductID)
	}
	// A copy: f is a value, so assigning here cannot reach the caller's struct.
	f.Product = s.ProductID
	return f, nil
}
