package service

import (
	"errors"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tickets/internal/domain"
)

// Filing a ticket, validated the way apps/web validates it.
//
// The bounds are not chosen here — they are copied from the zod schema on
// app/api/internal/platform-tickets/route.ts, because both write the same
// columns for the same product. A limit tightened on the way across would
// reject filings that succeed today, which is the one failure a migration
// must not introduce.

func goodCreate() CreateInput {
	return CreateInput{
		Subject:          "Payouts are delayed",
		Description:      "Three payouts have been pending since Tuesday.",
		SubmittedByName:  "Priya R",
		SubmittedByEmail: "priya@example.com",
	}
}

func TestAValidFilingIsAccepted(t *testing.T) {
	got, err := validateCreate(goodCreate())
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if got.Subject != "Payouts are delayed" {
		t.Errorf("Subject = %q", got.Subject)
	}
	// Unspecified priority becomes the column's default rather than empty, so
	// the insert does not depend on the caller having sent one.
	if got.Priority != domain.PriorityMedium {
		t.Errorf("Priority = %q, want medium by default", got.Priority)
	}
}

func TestSubjectAndDescriptionAreRequired(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*CreateInput)
	}{
		{"empty subject", func(c *CreateInput) { c.Subject = "" }},
		{"whitespace subject", func(c *CreateInput) { c.Subject = "   " }},
		{"empty description", func(c *CreateInput) { c.Description = "" }},
		{"whitespace description", func(c *CreateInput) { c.Description = "  \n " }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := goodCreate()
			tc.mutate(&in)
			if _, err := validateCreate(in); err == nil {
				t.Errorf("%s was accepted", tc.name)
			} else if !errors.Is(err, ErrRefused) {
				t.Errorf("want ErrRefused, got %v", err)
			}
		})
	}
}

func TestTheSubmitterIsRequired(t *testing.T) {
	// apps/web requires both a name and an email on a filing (unlike a reply,
	// where the email is optional). A ticket with no reachable submitter is a
	// support request nobody can answer.
	for _, tc := range []struct {
		name   string
		mutate func(*CreateInput)
	}{
		{"no name", func(c *CreateInput) { c.SubmittedByName = "" }},
		{"no email", func(c *CreateInput) { c.SubmittedByEmail = "" }},
		{"email with no @", func(c *CreateInput) { c.SubmittedByEmail = "priya.example.com" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := goodCreate()
			tc.mutate(&in)
			if _, err := validateCreate(in); err == nil {
				t.Errorf("%s was accepted", tc.name)
			}
		})
	}
}

func TestTheBoundsMatchTheColumnsAndTheSchemaTheyCameFrom(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*CreateInput)
	}{
		{"subject over 300", func(c *CreateInput) { c.Subject = strings.Repeat("a", 301) }},
		{"name over 200", func(c *CreateInput) { c.SubmittedByName = strings.Repeat("a", 201) }},
		{"email over 300", func(c *CreateInput) { c.SubmittedByEmail = strings.Repeat("a", 295) + "@x.com" }},
		{"user id over 200", func(c *CreateInput) { c.SubmittedByUserID = strings.Repeat("a", 201) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := goodCreate()
			tc.mutate(&in)
			if _, err := validateCreate(in); err == nil {
				t.Errorf("%s was accepted", tc.name)
			}
		})
	}
}

func TestALongDescriptionIsAccepted(t *testing.T) {
	// apps/web puts NO upper bound on the description, and the request body
	// cap (maxBodyBytes, via MaxBytesReader) is what actually bounds it. A
	// limit invented here would reject filings apps/web accepts.
	in := goodCreate()
	in.Description = strings.Repeat("a", 50_000)
	if _, err := validateCreate(in); err != nil {
		t.Errorf("a long description was refused: %v", err)
	}
}

func TestAnUnknownPriorityIsRefusedRatherThanDefaulted(t *testing.T) {
	// Defaulting would silently file an "urgant" ticket as medium, and the
	// merchant who typed it would never learn their urgency was dropped.
	in := goodCreate()
	in.Priority = "urgant"
	if _, err := validateCreate(in); err == nil {
		t.Error("an unknown priority was accepted")
	}
}

func TestAKnownPriorityIsCarried(t *testing.T) {
	in := goodCreate()
	in.Priority = "urgent"
	got, err := validateCreate(in)
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if got.Priority != domain.PriorityUrgent {
		t.Errorf("Priority = %q, want urgent", got.Priority)
	}
}

func TestTheSubmittersDetailsAreTrimmed(t *testing.T) {
	in := goodCreate()
	in.Subject = "  Payouts are delayed  "
	in.SubmittedByName = "  Priya R  "
	in.SubmittedByEmail = "  priya@example.com  "
	got, err := validateCreate(in)
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if got.Subject != "Payouts are delayed" || got.SubmittedByName != "Priya R" ||
		got.SubmittedByEmail != "priya@example.com" {
		t.Errorf("values were not trimmed: %+v", got)
	}
}
