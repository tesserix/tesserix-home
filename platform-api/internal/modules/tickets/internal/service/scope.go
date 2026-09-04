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
	// TenantID is the tenant the caller ASSERTED, and it is required of any
	// scoped caller.
	//
	// Asserted, not attested — the product forwards which tenant its merchant
	// belongs to, having authenticated that merchant itself. That is exactly
	// the trust model apps/web has today, and moving it unchanged is the point.
	//
	// What must not be possible is declining to say. apps/web requires
	// ?product= and ?tenant_id= on every internal ticket route and states why:
	// "without that check, any tenant holding the shared bearer could read any
	// other tenant's tickets". Product scoping alone reproduces that hole one
	// level down — mark8ly reading every mark8ly merchant's queue — so
	// ForTenant refuses a scoped caller that names no tenant.
	TenantID string
}

// ForTenant returns this scope narrowed to the tenant a caller named.
//
// A SCOPED caller must name one; an operator names none and stays unscoped.
func (s Scope) ForTenant(tenantID string) (Scope, error) {
	if s.Unscoped() {
		return s, nil
	}
	if tenantID == "" {
		return Scope{}, fmt.Errorf(
			"%w: a product caller must name the tenant it is acting for", ErrRefused)
	}
	// s is a value, so this cannot reach the caller's copy.
	s.TenantID = tenantID
	return s, nil
}

// Unscoped reports whether this scope confines nothing.
func (s Scope) Unscoped() bool { return s.ProductID == "" }

// Admits reports whether a ticket belonging to productID is visible here.
//
// The test is "equal to mine", never "not obviously someone else's": a ticket
// carrying no product is refused by a scoped caller rather than admitted for
// matching nothing.
func (s Scope) Admits(productID, tenantID string) bool {
	if s.Unscoped() {
		return true
	}
	return productID != "" && productID == s.ProductID &&
		tenantID != "" && tenantID == s.TenantID
}

// Apply confines a filter to this scope, returning a new one.
//
// A filter naming a DIFFERENT product is refused rather than rewritten.
// Rewriting would answer a question about Kora's queue with mark8ly's rows —
// a response that misrepresents the request, which is worse for the caller and
// no safer for anyone else.
//
// A filter naming the caller's OWN product is accepted unchanged, because that
// is what mark8ly's client sends today (`?product=mark8ly&tenant_id=...`) and
// this must not break it. The same holds for the tenant.
//
// The tenant is FORCED as well as the product. A scoped Scope always carries
// one — ForTenant refuses to build one without — so this cannot silently widen
// to the product's whole estate of tenants.
func (s Scope) Apply(f repository.Filter) (repository.Filter, error) {
	if s.Unscoped() {
		return f, nil
	}
	if f.Product != "" && f.Product != s.ProductID {
		return repository.Filter{}, fmt.Errorf(
			"%w: this caller may only read %s tickets", ErrRefused, s.ProductID)
	}
	if f.Tenant != "" && f.Tenant != s.TenantID {
		return repository.Filter{}, fmt.Errorf(
			"%w: this caller may only read its own tenant's tickets", ErrRefused)
	}
	// A copy: f is a value, so assigning here cannot reach the caller's struct.
	f.Product = s.ProductID
	f.Tenant = s.TenantID
	return f, nil
}
