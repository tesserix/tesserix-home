package auth

import "strings"

// Allowlist is the complete set of humans permitted to use this service.
// There are no roles below it: an address is either a full administrator of the
// secret store or it has no access at all.
type Allowlist struct {
	emails map[string]struct{}
}

func NewAllowlist(emails []string) *Allowlist {
	set := make(map[string]struct{}, len(emails))
	for _, e := range emails {
		if norm := normaliseEmail(e); norm != "" {
			set[norm] = struct{}{}
		}
	}
	return &Allowlist{emails: set}
}

func (a *Allowlist) Permits(email string) bool {
	norm := normaliseEmail(email)
	if norm == "" {
		return false
	}
	_, ok := a.emails[norm]
	return ok
}

func (a *Allowlist) Size() int { return len(a.emails) }

func normaliseEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
