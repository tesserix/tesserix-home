package domain_test

import (
	"errors"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// The domain's tests, written before anything was layered on top of it.
//
// What they are for is narrow and worth stating: this package holds the rules
// that are NOT the database's. The CHECK constraints already reject a bad
// status or priority at the schema, so the value of testing ParseStatus is not
// "does it reject nonsense" — it is that the rejection happens at the edge,
// with a message naming the accepted values, rather than as a driver error
// carrying a constraint name the caller cannot act on.

func TestParseStatusAcceptsEveryValueTheSchemaPermits(t *testing.T) {
	// The four values in pt_status_chk. Spelled out rather than ranged over
	// domain's own slice: a test that reads its expectations from the code it
	// tests agrees with any bug that code has.
	for _, raw := range []string{"open", "in_progress", "resolved", "closed"} {
		got, err := domain.ParseStatus(raw)
		if err != nil {
			t.Errorf("ParseStatus(%q) = error %v, want it accepted", raw, err)
		}
		if string(got) != raw {
			t.Errorf("ParseStatus(%q) = %q, want the value carried through unchanged", raw, got)
		}
	}
}

func TestParseStatusRejectsAnythingElse(t *testing.T) {
	// "Open" is in the list deliberately. The column is case-sensitive and the
	// CHECK constraint would reject it, so accepting it here would move the
	// failure from a 400 the caller can read to a 500 they cannot.
	for _, raw := range []string{"", "Open", "in progress", "reopened", "deleted", "open "} {
		if _, err := domain.ParseStatus(raw); err == nil {
			t.Errorf("ParseStatus(%q) = nil error, want a rejection", raw)
		}
	}
}

func TestParseStatusNamesWhatItWouldHaveAccepted(t *testing.T) {
	_, err := domain.ParseStatus("reopened")
	if err == nil {
		t.Fatal("ParseStatus(\"reopened\") = nil error, want a rejection")
	}
	// The whole reason this parse exists at the edge rather than being left to
	// the constraint. A caller told only "invalid" has to go and read the
	// schema; one told the four values can fix the request.
	for _, want := range []string{"open", "in_progress", "resolved", "closed"} {
		if !contains(err.Error(), want) {
			t.Errorf("ParseStatus error %q does not name the accepted value %q", err, want)
		}
	}
}

func TestParsePriorityAcceptsEveryValueTheSchemaPermits(t *testing.T) {
	for _, raw := range []string{"low", "medium", "high", "urgent"} {
		got, err := domain.ParsePriority(raw)
		if err != nil {
			t.Errorf("ParsePriority(%q) = error %v, want it accepted", raw, err)
		}
		if string(got) != raw {
			t.Errorf("ParsePriority(%q) = %q, want the value carried through unchanged", raw, got)
		}
	}
}

func TestParsePriorityRejectsAnythingElse(t *testing.T) {
	// "critical" is severityOf's OUTPUT, not a priority. The console maps
	// urgent → critical for styling, and a caller reading the rendered page
	// could plausibly send the rendered word back.
	for _, raw := range []string{"", "Urgent", "critical", "p1", "none"} {
		if _, err := domain.ParsePriority(raw); err == nil {
			t.Errorf("ParsePriority(%q) = nil error, want a rejection", raw)
		}
	}
}

func TestParseStatusAndParsePriorityDoNotAcceptEachOther(t *testing.T) {
	// Both are short lowercase strings off the same request body, and a handler
	// that transposed them would produce a query the database accepts on one
	// column and rejects on the other. Cheap to assert, and it pins the two
	// vocabularies apart.
	if _, err := domain.ParseStatus("urgent"); err == nil {
		t.Error("ParseStatus accepted a priority")
	}
	if _, err := domain.ParsePriority("open"); err == nil {
		t.Error("ParsePriority accepted a status")
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestTransitionRejectsANoOp(t *testing.T) {
	// Not pedantry: a no-op transition would still write an audit row and,
	// through the reply endpoint, could stamp resolved_at on a ticket whose
	// status nobody changed. Refusing it keeps "a transition happened" and
	// "a row was updated" the same statement.
	for _, status := range []domain.Status{
		domain.StatusOpen, domain.StatusInProgress, domain.StatusResolved, domain.StatusClosed,
	} {
		ticket := domain.Ticket{Status: status}
		if err := ticket.Transition(status); err == nil {
			t.Errorf("Transition(%s → %s) = nil error, want a rejection", status, status)
		}
	}
}

func TestTransitionAllowsEveryOtherMove(t *testing.T) {
	// Including out of `closed`. See TestTransitionAllowsReopeningAClosedTicket
	// for why that is not the oversight it looks like.
	all := []domain.Status{
		domain.StatusOpen, domain.StatusInProgress, domain.StatusResolved, domain.StatusClosed,
	}
	for _, from := range all {
		for _, to := range all {
			if from == to {
				continue
			}
			ticket := domain.Ticket{Status: from}
			if err := ticket.Transition(to); err != nil {
				t.Errorf("Transition(%s → %s) = %v, want it allowed", from, to, err)
			}
		}
	}
}

func TestTransitionAllowsReopeningAClosedTicket(t *testing.T) {
	// This is a deliberate reversal of the draft this module started from, and
	// the reason is worth keeping next to the assertion.
	//
	// The draft refused to leave `closed`, arguing that reopening needs a
	// record of who did it and why, and that "nothing in the schema records
	// who reopened what". That was true of the schema and is no longer true of
	// this service: every write here is audited in the same transaction, so a
	// reopen lands in console_audit_log with an actor, an action and a target.
	//
	// Refusing it anyway would break a control the console ships today.
	// `respond-controls.tsx` renders a Reopen button for any terminal status —
	// resolved AND closed — and apps/web's PATCH permits it. A module that
	// rejected the request would turn a working button into a 422 on the one
	// surface #269 is migrating.
	closed := domain.Ticket{Status: domain.StatusClosed}
	if err := closed.Transition(domain.StatusOpen); err != nil {
		t.Fatalf("reopening a closed ticket = %v, want it allowed — the console ships the button", err)
	}
}

func TestResolvesAtStampsOnTheFirstResolution(t *testing.T) {
	ticket := domain.Ticket{Status: domain.StatusOpen}
	if !ticket.ResolvesAt(domain.StatusResolved) {
		t.Error("ResolvesAt(resolved) on a never-resolved ticket = false, want true")
	}
}

func TestResolvesAtDoesNotRestampASecondResolution(t *testing.T) {
	// resolved_at records WHEN a ticket was first resolved. A ticket that
	// bounced back to in_progress and was resolved again must not lose its
	// original resolution time — the column is the answer to "how long did
	// this take", and restamping it would quietly reset that clock.
	first := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	ticket := domain.Ticket{Status: domain.StatusInProgress, ResolvedAt: &first}
	if ticket.ResolvesAt(domain.StatusResolved) {
		t.Error("ResolvesAt(resolved) on an already-stamped ticket = true, want false")
	}
}

func TestResolvesAtIgnoresEveryOtherDestination(t *testing.T) {
	// Notably `closed`. Closing an unresolved ticket is not resolving it —
	// a ticket closed as a duplicate or withdrawn was never answered, and
	// stamping resolved_at would put it in the resolved-this-week count.
	ticket := domain.Ticket{Status: domain.StatusOpen}
	for _, to := range []domain.Status{domain.StatusOpen, domain.StatusInProgress, domain.StatusClosed} {
		if ticket.ResolvesAt(to) {
			t.Errorf("ResolvesAt(%s) = true, want false — only `resolved` stamps", to)
		}
	}
}

func TestAuthorTypeValuesMatchTheCheckConstraint(t *testing.T) {
	// ptr_author_chk permits exactly these two, and parseTicketDetail on the
	// console REJECTS anything else rather than rendering it — a misattributed
	// message is worse than a failed read. Three spellings of this pair now
	// exist (schema, this package, the console parser); this pins ours.
	if string(domain.AuthorMerchant) != "merchant" {
		t.Errorf("AuthorMerchant = %q, want \"merchant\"", domain.AuthorMerchant)
	}
	if string(domain.AuthorOperator) != "platform_admin" {
		t.Errorf("AuthorOperator = %q, want \"platform_admin\" — the value the console parser accepts", domain.AuthorOperator)
	}
}

// Guards the error values are comparable text rather than a sentinel callers
// might start matching on. Recorded so a later change to typed errors is a
// deliberate act with this test to update, not an accident.
func TestParseErrorsAreNotSentinels(t *testing.T) {
	_, err := domain.ParseStatus("nope")
	if errors.Is(err, errors.ErrUnsupported) {
		t.Error("ParseStatus returned a stdlib sentinel; handlers branch on the parse failing, not on its identity")
	}
}

func TestReopeningIsTrueOnlyWhenLeavingATerminalState(t *testing.T) {
	cases := []struct {
		from, to domain.Status
		want     bool
	}{
		{domain.StatusClosed, domain.StatusOpen, true},
		{domain.StatusClosed, domain.StatusInProgress, true},
		{domain.StatusResolved, domain.StatusOpen, true},
		{domain.StatusResolved, domain.StatusInProgress, true},

		// Resolved → closed is not a reopen. Both are terminal, so nothing
		// comes back into the queue; it is a filing decision, and calling it
		// a reopen in the audit trail would make the log say the opposite of
		// what happened.
		{domain.StatusResolved, domain.StatusClosed, false},
		{domain.StatusClosed, domain.StatusResolved, false},

		// Ordinary forward movement.
		{domain.StatusOpen, domain.StatusInProgress, false},
		{domain.StatusOpen, domain.StatusResolved, false},
		{domain.StatusInProgress, domain.StatusClosed, false},
	}
	for _, c := range cases {
		ticket := domain.Ticket{Status: c.from}
		if got := ticket.Reopening(c.to); got != c.want {
			t.Errorf("Ticket{%s}.Reopening(%s) = %v, want %v", c.from, c.to, got, c.want)
		}
	}
}

func TestReopeningAgreesWithTheConsolesTerminalSet(t *testing.T) {
	// isTerminalStatus in lib/tickets.ts is ["resolved", "closed"]. If the two
	// drift, the console renders Reopen where this module does not call it one
	// (or the reverse), and the audit trail stops describing the button that
	// was pressed. Asserted through the exported behaviour, since the helper
	// itself is unexported.
	for _, terminal := range []domain.Status{domain.StatusResolved, domain.StatusClosed} {
		if !(domain.Ticket{Status: terminal}).Reopening(domain.StatusOpen) {
			t.Errorf("%s is terminal for the console but not for Reopening", terminal)
		}
	}
	for _, live := range []domain.Status{domain.StatusOpen, domain.StatusInProgress} {
		if (domain.Ticket{Status: live}).Reopening(domain.StatusOpen) {
			t.Errorf("%s is not terminal for the console but Reopening treats it as one", live)
		}
	}
}
