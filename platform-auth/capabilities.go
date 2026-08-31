// Package auth verifies Zitadel tokens and turns them into a Principal the
// modules can authorise against. Kernel, not a module.
//
// ADR-003 D8: two principal types, one issuer. An operator acting through the
// console and a product calling the API directly are proven the same way —
// verify against Zitadel's JWKS, check issuer and audience, read the project
// roles claim. They differ in which roles they hold, not in how they are
// proven.
package auth

import "slices"

// Capability is a role key from the Platform Console project.
//
// # This list is a contract, in two directions
//
// It must match the Zitadel project's role keys, and it must match
// packages/platform-auth/src/capabilities.ts. Three copies of one vocabulary is
// one more than anybody wants, and the alternative — the Go service importing
// the TypeScript package — does not exist. So the list is duplicated and a test
// asserts the shape, which is the same trade httpx makes with go-shared's error
// envelope.
//
// Renaming a value here without renaming it in Zitadel silently revokes
// access: the token keeps carrying the old key and every check for the new one
// denies.
type Capability string

const (
	// Console entry, and nothing else. #261 reduced it to this; it used to mean
	// "may do almost anything", which is how 11 of 14 mutating actions ended up
	// gated on the ticket every operator holds.
	CapRead Capability = "read"

	// Surfaces — WHERE a principal works.
	CapCRM      Capability = "crm"
	CapSupport  Capability = "support"
	CapBilling  Capability = "billing"
	CapPlatform Capability = "platform"

	// Verbs — WHAT may be done, orthogonal to surface. A verb layers on top of
	// surface access rather than replacing it: erasing a contact needs `crm`
	// AND `hard-delete`.
	CapRespond           Capability = "respond"
	CapRotateCredentials Capability = "rotate-credentials"
	CapAdjustBalance     Capability = "adjust-balance"
	CapExecuteRefund     Capability = "execute-refund"
	CapMassSend          Capability = "mass-send"
	CapHardDelete        Capability = "hard-delete"
	// CapPublishCatalog publishes the plan catalog to Stripe — creating,
	// replacing or archiving Prices.
	//
	// Deliberately NOT folded into CapRotateCredentials, which already covers
	// payment-gateway keys and Stripe settings: holding a credential verb
	// should not imply the ability to change what customers are charged.
	// Different blast radius, different grant. See capabilities.ts, which is
	// the authority this mirrors.
	CapPublishCatalog Capability = "publish-catalog"

	// CapReadPlanCatalog reads the PUBLISHED plan catalog. Held by a Zitadel
	// service user (a machine), never an operator — a machine enters no
	// console session and works in no surface, so it belongs in neither
	// Surfaces nor Verbs. Granting it must not carry CapBilling's wallets,
	// refunds, payouts and subscription state: a machine created to read
	// prices should not thereby hold the console's entire billing surface.
	// See capabilities.ts, which is the authority this mirrors.
	CapReadPlanCatalog Capability = "read-plan-catalog"
)

// Capabilities is every known role key, in the order capabilities.ts declares
// them. Order is asserted so a drift between the two files is a failing test
// rather than a discovery in production.
var Capabilities = []Capability{
	CapRead,
	CapCRM, CapSupport, CapBilling, CapPlatform,
	CapRespond, CapRotateCredentials, CapAdjustBalance,
	CapExecuteRefund, CapMassSend, CapHardDelete, CapPublishCatalog,
	CapReadPlanCatalog,
}

// Surfaces say where a principal works.
var Surfaces = []Capability{CapCRM, CapSupport, CapBilling, CapPlatform}

// Verbs say what a principal may do.
var Verbs = []Capability{
	CapRespond, CapRotateCredentials, CapAdjustBalance,
	CapExecuteRefund, CapMassSend, CapHardDelete, CapPublishCatalog,
}

// Machines are capabilities held by a service identity, never an operator.
//
// A third bucket, not a subset of Surfaces or Verbs: those two describe an
// operator's console session — where they work, what they may do there. A
// machine holds neither concept, so forcing it into one would misstate what
// it is rather than clarify it. Mirrors MACHINE_CAPABILITIES in
// capabilities.ts.
var Machines = []Capability{CapReadPlanCatalog}

func known(c Capability) bool {
	return slices.Contains(Capabilities, c)
}

// toCapabilities narrows arbitrary role strings from a token.
//
// Unknown roles are DROPPED, matching toCapabilities() in capabilities.ts. A
// role this service does not recognise cannot be checked meaningfully, and
// keeping it invites code elsewhere to match on a string nothing sanctioned.
//
// The consequence is worth stating because it is not obvious: a typo'd role key
// in Zitadel presents as "this principal holds nothing" and denies, rather than
// as an error naming the typo.
func toCapabilities(roles []string) []Capability {
	out := make([]Capability, 0, len(roles))
	for _, r := range roles {
		c := Capability(r)
		if known(c) {
			out = append(out, c)
		}
	}
	return out
}
