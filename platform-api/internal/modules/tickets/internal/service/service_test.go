package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// What a merchant sees on a reply: the platform, never a person.
//
// This reverses #450. That change resolved an operator's name and email from
// userinfo and passed them through actorOf, so displayName signed a reply with
// them; the test here asserted exactly that. It was the wrong outcome — a
// reply is read by a MERCHANT, outside this organisation, and a staff member's
// name and personal email address are not theirs to see.
//
// The old fallback cases went with it. The label is no longer reached when
// profile data is missing, so there is nothing left to fall back FROM: it is
// the intended identity of every platform reply.
func TestAReplyIsSignedByThePlatformRatherThanByTheOperator(t *testing.T) {
	if got, want := (Actor{Subject: "386888878927118733"}).displayName(), "Tesserix Support"; got != want {
		t.Fatalf("displayName() = %q, want %q", got, want)
	}
}

// The stored row, not just the label — because the label alone would not
// catch an email being written beside it.
//
// Goes through Service.Reply and reads the columns back, since the three
// properties that matter are three separate columns and only one of them is
// visible from displayName. Skips without TESSERIX_TEST_DB_HOST, as every
// database test in this service does.
func TestAStoredReplyCarriesTheLabelNoEmailAndTheSubject(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	svc := New(pool)

	const subject = "386888878927118733"
	ticketID := seedTicket(t, pool)

	if _, err := svc.Reply(ctx, Actor{Subject: subject}, ticketID,
		ReplyInput{Content: "Looking into this now."}, nil); err != nil {
		t.Fatalf("Reply: %v", err)
	}

	var name string
	// author_email is read as a pointer so a NULL is distinguishable from an
	// empty string. nullIfEmpty (repository/tickets.go) is what makes it NULL,
	// and a blank string in a column a console might render is a different —
	// worse — outcome than an absent one.
	var email *string
	var userID string
	err := pool.QueryRow(ctx,
		`SELECT author_name, author_email, author_user_id
		   FROM platform_ticket_replies
		  WHERE ticket_id = $1::uuid`, ticketID,
	).Scan(&name, &email, &userID)
	if err != nil {
		t.Fatalf("reading the stored reply: %v", err)
	}

	if name != "Tesserix Support" {
		t.Errorf("author_name = %q, want %q — a merchant is being shown a staff member", name, "Tesserix Support")
	}
	if email != nil {
		t.Errorf("author_email = %q, want NULL — a staff member's address reached a merchant", *email)
	}
	// Pinned because it is now the ONLY attribution on the row. If this ever
	// stops being written, who replied becomes unrecoverable from the reply
	// itself, and the next reader will "fix" it by restoring the email.
	if userID != subject {
		t.Errorf("author_user_id = %q, want %q — internal attribution was lost", userID, subject)
	}
}

// seedTicket inserts the one ticket a reply needs.
//
// Written as an explicit INSERT against the real schema, like the repository
// package's own fixture, so a column this test gets wrong fails here rather
// than agreeing with whatever the author believed the schema was.
func seedTicket(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO platform_tickets
		   (product_id, tenant_id, ticket_number, subject, description,
		    status, priority, submitted_by_name, submitted_by_email)
		 VALUES ('mark8ly', '3f2a1c94-0000-4000-8000-0000000000aa'::uuid, 'M8-0001',
		         'a question', 'the description', 'open', 'medium',
		         'A Merchant', 'merchant@example.test')
		 RETURNING id::text`).Scan(&id)
	if err != nil {
		t.Fatalf("seeding a ticket: %v", err)
	}
	return id
}
