package service

import (
	"errors"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// What a reply does to the ticket it lands on.
//
// Pure, so the rules are checked wherever the tests run rather than only where
// a postgres is configured. Two of the three are behaviours apps/web has and
// platform-api did not, and their absence is not visible in a response — a
// merchant's follow-up simply lands on a ticket nobody is looking at.

func merchantAuthor() replyAuthor { return replyAuthor{Type: domain.AuthorMerchant} }
func operatorAuthor() replyAuthor { return replyAuthor{Type: domain.AuthorOperator} }

func TestAMerchantReplyReopensAResolvedTicket(t *testing.T) {
	// The one that matters most. Without it a merchant's follow-up leaves the
	// ticket resolved, the platform team never sees it in their open queue,
	// and the conversation dies with the merchant still waiting.
	status, action, err := replyEffect(merchantAuthor(), domain.StatusResolved, nil)
	if err != nil {
		t.Fatalf("replyEffect: %v", err)
	}
	if status == nil || *status != domain.StatusOpen {
		t.Fatalf("status = %v, want open", status)
	}
	if action != "tickets.reopen" {
		t.Errorf("action = %q, want tickets.reopen — the trail must distinguish a reopen", action)
	}
}

func TestAMerchantMayNotReplyToAClosedTicket(t *testing.T) {
	// apps/web answers 409. Resolved is fine — that is the reopen above — and
	// closed is the platform's own act, which a merchant does not undo.
	_, _, err := replyEffect(merchantAuthor(), domain.StatusClosed, nil)
	if err == nil {
		t.Fatal("a merchant replied to a closed ticket")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}

func TestAMerchantReplyToALiveTicketChangesNothing(t *testing.T) {
	for _, status := range []domain.Status{domain.StatusOpen, domain.StatusInProgress} {
		got, action, err := replyEffect(merchantAuthor(), status, nil)
		if err != nil {
			t.Fatalf("replyEffect(%s): %v", status, err)
		}
		if got != nil {
			t.Errorf("a reply to a %s ticket moved it to %v", status, *got)
		}
		if action != "tickets.reply" {
			t.Errorf("action = %q, want tickets.reply", action)
		}
	}
}

func TestAnOperatorReplyNeverReopensByItself(t *testing.T) {
	// The reopen is a MERCHANT's follow-up returning a ticket to the queue.
	// An operator replying to a resolved ticket is closing the loop, not
	// reopening it, and has PATCH if they mean to transition.
	got, action, err := replyEffect(operatorAuthor(), domain.StatusResolved, nil)
	if err != nil {
		t.Fatalf("replyEffect: %v", err)
	}
	if got != nil {
		t.Errorf("an operator's reply reopened a resolved ticket to %v", *got)
	}
	if action != "tickets.reply" {
		t.Errorf("action = %q, want tickets.reply", action)
	}
}

func TestAnOperatorMayReplyToAClosedTicket(t *testing.T) {
	if _, _, err := replyEffect(operatorAuthor(), domain.StatusClosed, nil); err != nil {
		t.Errorf("an operator was refused a reply on a closed ticket: %v", err)
	}
}

func TestAnExplicitTransitionIsHonouredAndNotOverriddenByTheReopen(t *testing.T) {
	// An operator carrying a transition keeps it, even on a resolved ticket.
	wanted := domain.StatusInProgress
	got, action, err := replyEffect(operatorAuthor(), domain.StatusResolved, &wanted)
	if err != nil {
		t.Fatalf("replyEffect: %v", err)
	}
	if got == nil || *got != domain.StatusInProgress {
		t.Fatalf("status = %v, want in_progress", got)
	}
	if action != "tickets.reply" {
		t.Errorf("action = %q, want tickets.reply", action)
	}
}
