// Package service holds the CRM queues module's operations: the wire
// representations it answers with, and (from Task 5) the transaction scripts
// behind its write verbs.
//
// Under modules/crm/internal/, so only code rooted at modules/crm/ can import
// it.
package service

import (
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
)

// # The wire shapes, and why they are not the screen's
//
// §2's rule is that a module exposes DOMAIN resources and the console
// composes the screen. The temptation this module has to resist is named
// explicitly in the brief, and it has a worked example one file over in the
// console: `OrganisationListRow` (apps/console/lib/db/crm-repo.ts:2157)
// carries `contactName`, `contactEmail`, `contactHandle`, `contactCount`,
// `openOpportunities` and a `products` array. None of those are facts about
// an organisation. They are the columns of a table, denormalised into a row
// type because one React component renders them side by side — and the proof
// is that every one of them is either a fact about a DIFFERENT resource (a
// contact, an opportunity) or an aggregate over one.
//
// So the queue's resource here is the OPPORTUNITY and nothing else. What that
// costs and what it buys is stated below, per field, because the argument is
// only worth anything if it survives contact with the two fields that look
// like exceptions.
//
// # organisation_name IS on the resource, deliberately
//
// It is denormalised — it is a column of `crm_organisations`, joined in — so
// by the rule above it is exactly the thing to be suspicious of. It stays,
// and here is the distinction it turns on.
//
// An opportunity has no name, no title and no subject column. Its own
// identifying string IS its organisation's name: "the Acme deal" is how every
// caller, human or otherwise, refers to it. A resource that could not be
// identified without a second request is not a resource, it is a foreign key
// with decoration. Contrast `contactCount`: an organisation is perfectly
// identifiable without it, and a caller that wants it is asking a question
// about CONTACTS.
//
// The other half of the test is what a field commits this contract to. A name
// is 1:1 with the id already on the row, immutable in practice, needs no
// second query the row's own JOIN does not already make, and can never
// disagree with itself. An aggregate commits the API to recomputing a number
// per row, and a count that is one transaction stale is a number on a screen
// that is quietly wrong. The first is a projection; the second is a
// subquery per row wearing a field's clothing.
//
// # What is deliberately ABSENT, and where the console gets it
//
// The queue screen renders a primary contact's handle and follower count
// beside each row. They are NOT here. They are facts about a CONTACT, they
// are chosen by a tie-broken ordering the console can no more assume than
// this service can (repository.primaryContactOrder), and putting them on an
// opportunity would publish that ordering as part of this contract — meaning
// the day the "which contact is primary" rule changes, every consumer of the
// queue is affected rather than the organisations resource alone.
//
// The organisation's `country` is absent for the plainer version of the same
// reason: it is a column of `crm_organisations`, it fails the identification
// test `organisation_name` passes — an opportunity is perfectly identifiable
// without it — and a caller that wants it is asking a question about the
// ORGANISATION. That it is one of the five FILTER axes does not make it a
// field: a filter narrows which rows come back, and there is no rule saying
// every axis must also be echoed on each row. `followers` is the same case,
// and between them they are two of the five axes that are deliberately not
// resource fields.
//
// The console composes both from the organisations resource, which is the
// layer it already has (apps/console/lib/platform-api.ts). The cost is one
// extra request on the queue screen; the same cost §2 accepted for the ticket
// summary, and for the same reason.
//
// # quiet_since IS on the resource, and it is defined by its MEANING
//
// `quiet_since` is the instant this opportunity last showed signs of life —
// and, equivalently, the value the DRIFTING queue orders by. That is the
// contract. It stays on the resource because it is the meaning of the sequence
// the caller is holding: a caller that derived it itself would hold a second
// copy of a rule that decides row order, and the two copies would disagree the
// first time either changed.
//
// TODAY it is derived as COALESCE(last_contacted_at, created_at). That is the
// current derivation, NOT the definition, and the distinction is the whole
// point of writing it this way round.
//
// Documenting the SQL as the contract would publish an implementation. The two
// are only accidentally identical: if the drift rule ever widens — a
// `last_activity_at` from a later migration, say, or taking `next_action_at`
// into account — then a service that kept the documented SQL would break the
// ordering guarantee callers actually rely on, while a service that kept the
// guarantee would silently change the field's documented meaning. Both are
// bad, and the choice only exists if the comment names the mechanism. Defined
// by its meaning, the same widening is an additive change: the field still
// answers the question it always answered.
//
// Note it is present on DUE rows too, where it orders nothing. Uniformity of
// the resource beats minimality of each response: one shape, one parser.
//
// # snake_case
//
// The estate's spelling, and what the console's parsers already accept first.

// Opportunity is one row of a queue on the wire.
//
// The nullable fields are pointers so `null` and absent-from-the-struct stay
// distinguishable, and they are rendered as explicit `null` rather than
// omitted: an unattributed lead — the common case, since every import lands
// with no product — should say "asked and unanswered", not vanish. It is also
// what makes the `product_unset=true` filter's own results representable.
type Opportunity struct {
	ID               string     `json:"id"`
	OrganisationID   string     `json:"organisation_id"`
	OrganisationName string     `json:"organisation_name"`
	Product          *string    `json:"product"`
	Stage            string     `json:"stage"`
	Owner            *string    `json:"owner"`
	NextActionAt     *time.Time `json:"next_action_at"`
	NextActionNote   *string    `json:"next_action_note"`
	LastContactedAt  *time.Time `json:"last_contacted_at"`
	// QuietSince is the instant this opportunity last showed signs of life —
	// the value the drifting queue orders by. Derived TODAY as
	// COALESCE(last_contacted_at, created_at); see the package comment for why
	// the derivation is not the definition. Never null.
	QuietSince time.Time `json:"quiet_since"`
	IsStarred  bool      `json:"is_starred"`
}

// QueuePayload is what both queues answer with.
//
// One payload type, not a DuePayload and a DriftingPayload. The two endpoints
// select different rows; they do not return different THINGS, and a console
// (or a product) that wrote two parsers for one resource would be maintaining
// a difference this service does not have.
//
// A named object rather than a bare array, for §2's reason: a named object can
// gain a sibling field without becoming a different type.
type QueuePayload struct {
	Opportunities []Opportunity `json:"opportunities"`
}

// utc normalises a timestamp for the wire.
//
// pgx returns timestamptz in the connection's session timezone, so a laptop in
// +10:00 and a container in UTC serialise the SAME ROW differently. Both parse,
// so nothing breaks loudly — which is exactly why it is pinned. The tickets
// module found this by running the service rather than by testing it; the
// golden files mask the timestamp value, which also masks its offset.
func utc(t time.Time) time.Time { return t.UTC() }

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	normalised := t.UTC()
	return &normalised
}

func toOpportunity(o domain.Opportunity) Opportunity {
	return Opportunity{
		ID:               o.ID,
		OrganisationID:   o.OrganisationID,
		OrganisationName: o.OrganisationName,
		Product:          o.Product,
		Stage:            string(o.Stage),
		Owner:            o.Owner,
		NextActionAt:     utcPtr(o.NextActionAt),
		NextActionNote:   o.NextActionNote,
		LastContactedAt:  utcPtr(o.LastContactedAt),
		QuietSince:       utc(o.QuietSince),
		IsStarred:        o.IsStarred,
	}
}

func toOpportunities(rows []domain.Opportunity) []Opportunity {
	// Non-nil, so an empty queue serialises as [] rather than null. A client
	// that types the field as an array meets a type error on the one response
	// it is least likely to have exercised — and "nothing due" is the response
	// this queue is MEANT to reach.
	out := make([]Opportunity, 0, len(rows))
	for _, o := range rows {
		out = append(out, toOpportunity(o))
	}
	return out
}
