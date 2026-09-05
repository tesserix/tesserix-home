package auth_test

import (
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	authcore "github.com/tesserix/tesserix-home/platform-auth"
)

// The alias layer exists so 65 importers need no edit. Its one failure mode is
// someone "fixing" a build error by writing a real constant here instead of an
// alias, at which point platform-api and secrets-api disagree about the
// vocabulary and nothing says so. This test is what says so.
func TestAliasesAreTheSameValuesNotCopies(t *testing.T) {
	if len(auth.Capabilities) != len(authcore.Capabilities) {
		t.Fatalf("capability count: alias has %d, platform-auth has %d",
			len(auth.Capabilities), len(authcore.Capabilities))
	}
	for i, want := range authcore.Capabilities {
		if auth.Capabilities[i] != want {
			t.Errorf("Capabilities[%d] = %q, platform-auth has %q", i, auth.Capabilities[i], want)
		}
	}

	pairs := []struct {
		name       string
		alias, src auth.Capability
	}{
		{"CapRead", auth.CapRead, authcore.CapRead},
		{"CapCRM", auth.CapCRM, authcore.CapCRM},
		{"CapSupport", auth.CapSupport, authcore.CapSupport},
		{"CapBilling", auth.CapBilling, authcore.CapBilling},
		{"CapPlatform", auth.CapPlatform, authcore.CapPlatform},
		{"CapRespond", auth.CapRespond, authcore.CapRespond},
		{"CapRotateCredentials", auth.CapRotateCredentials, authcore.CapRotateCredentials},
		{"CapAdjustBalance", auth.CapAdjustBalance, authcore.CapAdjustBalance},
		{"CapExecuteRefund", auth.CapExecuteRefund, authcore.CapExecuteRefund},
		{"CapMassSend", auth.CapMassSend, authcore.CapMassSend},
		{"CapHardDelete", auth.CapHardDelete, authcore.CapHardDelete},
		{"CapPublishCatalog", auth.CapPublishCatalog, authcore.CapPublishCatalog},
		{"CapReadPlanCatalog", auth.CapReadPlanCatalog, authcore.CapReadPlanCatalog},
		// CapReadPromoCatalog was added to platform-auth (#521) without ever
		// reaching this layer — the capability count check above passes on
		// Capabilities alone, so a missing CONSTANT alias went unnoticed. Pinned
		// here now so the next one cannot.
		{"CapReadPromoCatalog", auth.CapReadPromoCatalog, authcore.CapReadPromoCatalog},
		{"CapProductSupport", auth.CapProductSupport, authcore.CapProductSupport},
		{"CapReadAnnouncements", auth.CapReadAnnouncements, authcore.CapReadAnnouncements},
	}
	for _, p := range pairs {
		if p.alias != p.src {
			t.Errorf("%s = %q, platform-auth has %q", p.name, p.alias, p.src)
		}
	}
}

// errors.Is must work across the module boundary, or every caller that checks
// for a specific verification failure silently stops matching.
func TestAliasedErrorsAreTheSameValues(t *testing.T) {
	errs := []struct {
		name       string
		alias, src error
	}{
		{"ErrNotJWT", auth.ErrNotJWT, authcore.ErrNotJWT},
		{"ErrAudience", auth.ErrAudience, authcore.ErrAudience},
		{"ErrNoRoles", auth.ErrNoRoles, authcore.ErrNoRoles},
		{"ErrExpired", auth.ErrExpired, authcore.ErrExpired},
		{"ErrInvalid", auth.ErrInvalid, authcore.ErrInvalid},
		{"ErrAuthDisabled", auth.ErrAuthDisabled, authcore.ErrAuthDisabled},
	}
	for _, e := range errs {
		if e.alias != e.src {
			t.Errorf("%s is a different error value from platform-auth's", e.name)
		}
	}
}
