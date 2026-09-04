package service

import (
	"errors"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// Who a reply is FROM, decided in one place.
//
// Before #152 this was not a decision: every reply was the platform's, because
// the only caller was the console. Actor.displayName's comment recorded the
// precondition — "a merchant's own replies do not come through here" — and a
// product's machine relaying a merchant is precisely what removes it.
//
// Getting this wrong is not a 500. It is a merchant's words filed under the
// support team's name, on the thread that merchant reads, discovered later by
// a human reading a conversation that makes no sense.

const opSubject = "operator-subject-1"

func merchant() *Author {
	return &Author{Name: "Priya R", Email: "priya@example.com", UserID: "firebase-uid-123"}
}

func TestAnOperatorsReplyIsSignedByThePlatform(t *testing.T) {
	got, err := authorFor(Scope{}, Actor{Subject: opSubject}, nil)
	if err != nil {
		t.Fatalf("authorFor: %v", err)
	}
	if got.Type != domain.AuthorOperator {
		t.Errorf("Type = %q, want %q", got.Type, domain.AuthorOperator)
	}
	if got.Name != "Tesserix Support" {
		t.Errorf("Name = %q, want the fixed platform label", got.Name)
	}
	if got.Email != "" {
		t.Errorf("Email = %q — a staff member's address is not a merchant's to see", got.Email)
	}
	if got.UserID != opSubject {
		t.Errorf("UserID = %q, want the operator's subject for internal attribution", got.UserID)
	}
}

func TestAnOperatorMayNotPostAsAMerchant(t *testing.T) {
	// Otherwise anyone holding the console's write capability could forge a
	// message from a named merchant onto that merchant's own thread.
	_, err := authorFor(Scope{}, Actor{Subject: opSubject}, merchant())
	if err == nil {
		t.Fatal("an operator was allowed to supply a merchant author")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}

func TestAMachinesReplyIsAttributedToTheMerchantItRelays(t *testing.T) {
	got, err := authorFor(Scope{ProductID: "mark8ly", TenantID: tenantA}, Actor{Subject: "machine-1"}, merchant())
	if err != nil {
		t.Fatalf("authorFor: %v", err)
	}
	if got.Type != domain.AuthorMerchant {
		t.Errorf("Type = %q, want %q — this is the bug that would corrupt a live thread", got.Type, domain.AuthorMerchant)
	}
	if got.Name != "Priya R" {
		t.Errorf("Name = %q, want the merchant's own name", got.Name)
	}
	if got.Email != "priya@example.com" {
		t.Errorf("Email = %q, want the merchant's own address", got.Email)
	}
	if got.UserID != "firebase-uid-123" {
		t.Errorf("UserID = %q, want the merchant's foreign id", got.UserID)
	}
}

func TestAMachineMustSayWhoItIsRelaying(t *testing.T) {
	// Silently falling back to the platform label is the exact corruption this
	// contract exists to prevent, so an absent author is refused.
	_, err := authorFor(Scope{ProductID: "mark8ly", TenantID: tenantA}, Actor{Subject: "machine-1"}, nil)
	if err == nil {
		t.Fatal("a machine was allowed to reply with no author")
	}
	if !errors.Is(err, ErrRefused) {
		t.Errorf("want ErrRefused, got %v", err)
	}
}

func TestAMerchantAuthorNeedsAName(t *testing.T) {
	// author_name is NOT NULL and the console renders it directly, so a blank
	// one produces a message that appears to be from nobody.
	for _, name := range []string{"", "   "} {
		_, err := authorFor(Scope{ProductID: "mark8ly", TenantID: tenantA}, Actor{Subject: "machine-1"},
			&Author{Name: name, Email: "priya@example.com"})
		if err == nil {
			t.Errorf("a merchant author with name %q was accepted", name)
		}
	}
}

func TestAMerchantAuthorMayOmitEmailAndUserID(t *testing.T) {
	// apps/web's schema makes both optional (authorEmail, authorUserId), and a
	// migration that started requiring them would reject replies it accepts today.
	got, err := authorFor(Scope{ProductID: "mark8ly", TenantID: tenantA}, Actor{Subject: "machine-1"},
		&Author{Name: "Priya R"})
	if err != nil {
		t.Fatalf("authorFor: %v", err)
	}
	if got.Name != "Priya R" || got.Email != "" || got.UserID != "" {
		t.Errorf("author = %+v, want the name alone", got)
	}
}

func TestAMerchantAuthorIsBoundedByTheColumnsItIsWrittenTo(t *testing.T) {
	// The same bounds apps/web enforces: name 200, email 300, user id 200.
	for _, tc := range []struct {
		name   string
		author *Author
	}{
		{"name", &Author{Name: strings.Repeat("a", 201), Email: "p@example.com"}},
		{"email", &Author{Name: "Priya R", Email: strings.Repeat("a", 295) + "@x.com"}},
		{"user id", &Author{Name: "Priya R", UserID: strings.Repeat("a", 201)}},
	} {
		if _, err := authorFor(Scope{ProductID: "mark8ly", TenantID: tenantA},
			Actor{Subject: "machine-1"}, tc.author); err == nil {
			t.Errorf("an over-long %s was accepted", tc.name)
		}
	}
}

func TestAMerchantNameIsTrimmedRatherThanStoredWithItsPadding(t *testing.T) {
	got, err := authorFor(Scope{ProductID: "mark8ly", TenantID: tenantA}, Actor{Subject: "machine-1"},
		&Author{Name: "  Priya R  ", Email: "  priya@example.com  "})
	if err != nil {
		t.Fatalf("authorFor: %v", err)
	}
	if got.Name != "Priya R" {
		t.Errorf("Name = %q, want it trimmed", got.Name)
	}
	if got.Email != "priya@example.com" {
		t.Errorf("Email = %q, want it trimmed", got.Email)
	}
}
