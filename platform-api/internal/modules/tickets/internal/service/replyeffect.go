package service

import (
	"fmt"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// replyEffect decides what a reply does to the ticket it lands on.
//
// Returns the transition to apply (nil for none) and the name the audit trail
// should give the act.
//
// # Why a merchant's reply is not just a message
//
// Both special cases are apps/web behaviours that platform-api did not have,
// and neither is visible in a response — which is what makes them worth
// pinning rather than discovering:
//
//   - A merchant's reply to a RESOLVED ticket REOPENS it. Without this the
//     follow-up lands on a ticket nobody is looking at, the platform team
//     never sees it in their open queue, and the conversation dies with the
//     merchant still waiting for an answer.
//   - A merchant may not reply to a CLOSED ticket. Resolved is different, and
//     the distinction is the point: resolved is "we think this is done" and a
//     merchant may say otherwise; closed is the platform's own act.
//
// # Why it is decided here rather than by the caller
//
// The reopen is the SERVER's decision, taken from the ticket's own state. A
// scoped caller is refused a transition of its own precisely so that this is
// the only status change a product can cause — otherwise the reply body would
// be a way around the operator-only PATCH gate.
//
// An explicit transition, which only an operator may send, is honoured
// unchanged: the reopen fills a gap, it does not override an instruction.
func replyEffect(author replyAuthor, current domain.Status, requested *domain.Status) (*domain.Status, string, error) {
	if author.Type != domain.AuthorMerchant {
		return requested, "tickets.reply", nil
	}

	if current == domain.StatusClosed {
		return nil, "", fmt.Errorf("%w: this ticket is closed", ErrRefused)
	}

	if current == domain.StatusResolved && requested == nil {
		reopened := domain.StatusOpen
		return &reopened, "tickets.reopen", nil
	}

	return requested, "tickets.reply", nil
}
