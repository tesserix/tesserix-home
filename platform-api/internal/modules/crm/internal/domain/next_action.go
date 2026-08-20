package domain

import (
	"fmt"
	"strings"
	"time"
)

// MaxNextActionNoteLength bounds the note attached to a scheduled next action.
//
// The console imposes no limit — `next_action_note` is an unbounded `text`
// column (migration 0019) and its form is a single-line input, so nobody has
// ever reached one. This API is not a form: the handler's body cap is 64 KiB,
// and without a domain rule the whole of that would be storable in a field the
// queue renders inline beside a date. So the cap is a rule this module states
// rather than one it inherits, and it is generous enough that no operator
// typing a reminder can meet it.
const MaxNextActionNoteLength = 2000

// NextAction is what a scheduled next action IS: an instant and a note, each
// independently optional.
//
// Both nil is the legitimate CLEAR — "there is nothing scheduled on this deal"
// — and it is the reason neither field is required. The console's
// scheduleNextAction takes `at: string | null, note: string | null` for the
// same reason.
type NextAction struct {
	// At is when the action falls due. nil clears it, which also removes the
	// opportunity from the due queue and puts it in reach of the drifting one.
	At *time.Time
	// Note is what the action IS. nil clears it.
	Note *string
}

// Validate refuses a next action the domain will not store.
//
// The note is trimmed by the caller before it gets here (see Normalise): a
// note of spaces is not a note, and storing one puts a blank reminder on a
// queue row where an operator expects either text or nothing.
func (n NextAction) Validate() error {
	if n.Note != nil && len(*n.Note) > MaxNextActionNoteLength {
		return fmt.Errorf("a next-action note is limited to %d characters, got %d",
			MaxNextActionNoteLength, len(*n.Note))
	}
	return nil
}

// Normalise collapses a whitespace-only note to "no note".
//
// Returned as a new value rather than mutating the receiver, so a caller
// cannot end up holding two spellings of the same request.
func (n NextAction) Normalise() NextAction {
	if n.Note == nil {
		return n
	}
	trimmed := strings.TrimSpace(*n.Note)
	if trimmed == "" {
		return NextAction{At: n.At}
	}
	return NextAction{At: n.At, Note: &trimmed}
}

// Scheduled reports whether this action puts something on the calendar, as
// opposed to clearing it. The audit summary counts on it — see the service.
func (n NextAction) Scheduled() bool { return n.At != nil }

// RequiresProduct reports whether an opportunity at this stage must carry a
// product to satisfy `crm_opp_product_required_when_qualified`.
//
// The mirror of apps/console/lib/crm.ts's requiresProduct, and of the CHECK in
// migration 0019: everything from `qualified` onward. Stated as a predicate
// rather than inlined, because the repository's guard, the refusal message and
// this rule must be three views of ONE fact.
func RequiresProduct(s Stage) bool { return s != StageNew && s != StageContacted }
