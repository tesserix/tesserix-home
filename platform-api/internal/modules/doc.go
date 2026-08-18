// Package modules is the root of the platform API's domain modules.
//
// # The rule
//
// A module MUST NOT import another module. Not its internals, not its public
// package, not its types. Modules compose through the platform kernel
// (internal/platform/...) or through an interface the consumer defines and the
// provider satisfies — never by importing a sibling directly.
//
// # Why this is enforced from an empty directory
//
// ADR-003 D2a chose a modular monolith over a service per domain, and made the
// choice contingent on exactly one thing:
//
//	"This decision depends entirely on the enforcement landing with the first
//	module, not the third. Without it, the modules erode, extraction stops
//	being cheap, and the service-per-domain instinct becomes retroactively
//	correct. The enforcement is the thing that keeps the option open."
//
// The reversibility argument is what carried that decision: with seams that
// hold, extracting a module later is mechanical. Seams that have already been
// crossed a dozen times are not seams. So the rule ships before anything can
// break it, which is also the only moment it costs nothing.
//
// # Two mechanisms, because one is not enough
//
// Go's internal/ visibility does the first half. A module keeps its repository,
// its domain types and its SQL under modules/<name>/internal/..., which the
// compiler permits only code rooted at modules/<name>/ to import. Nothing else
// can reach a module's guts, and that is a compile error rather than a review
// comment.
//
// It does not do the second half. modules/billing importing modules/tickets —
// the public package, not its internals — compiles perfectly well, because they
// share the modules/ root. That is the import a modular monolith actually dies
// of, and it is what the checker in internal/architecture forbids.
//
// # What a module looks like
//
//	modules/tickets/
//	    tickets.go            the module's public surface: Register, its
//	                          config struct, and nothing else
//	    internal/
//	        repository/       SQL, compile-error-unreachable from outside
//	        domain/           types and rules
//	        handler/          HTTP handlers
//
// # When a module genuinely needs another module's data
//
// Define the interface where it is consumed, and satisfy it at composition
// time in cmd/server. The consuming module depends on its own interface; the
// providing module does not know it exists. That is the seam that makes a
// later extraction a matter of swapping a local implementation for an HTTP
// client, rather than a refactor.
package modules
