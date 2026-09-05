// This file is an alias layer, not a second definition.
//
// The Zitadel verifier and the capability vocabulary live in the platform-auth
// module, because secrets-api needs them too and Go's internal/ rule forbids
// importing platform-api/internal/... across module roots.
//
// Everything below is a Go alias or a re-exported value — never a copy. That
// distinction is the point: an alias cannot drift, whereas a copied constant
// can be edited here and silently disagree with Zitadel. alias_test.go asserts
// it stays that way.
//
// middleware.go is deliberately NOT here. It is net/http-specific refusal
// policy that depends on internal/platform/reqid, so it stays in this package.
package auth

import authcore "github.com/tesserix/tesserix-home/platform-auth"

type (
	Capability    = authcore.Capability
	Claims        = authcore.Claims
	Config        = authcore.Config
	OIDCParser    = authcore.OIDCParser
	Option        = authcore.Option
	Principal     = authcore.Principal
	PrincipalKind = authcore.PrincipalKind
	TokenParser   = authcore.TokenParser
	Verifier      = authcore.Verifier
)

const (
	CapRead              = authcore.CapRead
	CapCRM               = authcore.CapCRM
	CapSupport           = authcore.CapSupport
	CapBilling           = authcore.CapBilling
	CapPlatform          = authcore.CapPlatform
	CapRespond           = authcore.CapRespond
	CapRotateCredentials = authcore.CapRotateCredentials
	CapAdjustBalance     = authcore.CapAdjustBalance
	CapExecuteRefund     = authcore.CapExecuteRefund
	CapMassSend          = authcore.CapMassSend
	CapHardDelete        = authcore.CapHardDelete
	CapPublishCatalog    = authcore.CapPublishCatalog
	CapReadPlanCatalog   = authcore.CapReadPlanCatalog
	CapReadPromoCatalog  = authcore.CapReadPromoCatalog
	CapProductSupport    = authcore.CapProductSupport
	CapReadAnnouncements = authcore.CapReadAnnouncements

	KindOperator = authcore.KindOperator
	KindService  = authcore.KindService
)

// Slices share their backing array with platform-auth's, so these are the same
// values rather than copies of them.
var (
	Capabilities = authcore.Capabilities
	Surfaces     = authcore.Surfaces
	Verbs        = authcore.Verbs
	Machines     = authcore.Machines
)

// The same error VALUES, so errors.Is across the module boundary works.
var (
	ErrNotJWT       = authcore.ErrNotJWT
	ErrAudience     = authcore.ErrAudience
	ErrNoRoles      = authcore.ErrNoRoles
	ErrExpired      = authcore.ErrExpired
	ErrInvalid      = authcore.ErrInvalid
	ErrAuthDisabled = authcore.ErrAuthDisabled
)

// Function values rather than wrappers: a wrapper can drift in signature, a
// value cannot.
var (
	NewOIDCParser         = authcore.NewOIDCParser
	NewVerifier           = authcore.NewVerifier
	NewVerifierFromConfig = authcore.NewVerifierFromConfig
	WithConsoleClientID   = authcore.WithConsoleClientID
)
