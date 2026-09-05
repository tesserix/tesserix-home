package service

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/domain"
)

// Authoring an announcement is the estate's one IRREVOCABLE broadcast: once a
// published, in-window row exists, every matching product shows it on its next
// poll and there is no recall. So the validation is pinned rather than trusted,
// and it is pure so the pins hold wherever the tests run.
//
// The bounds are apps/web's, copied: title 200, body non-empty, severity from
// the CHECK constraint. Tightening any of them would refuse an announcement
// that can be authored today.

func good() CreateInput {
	return CreateInput{Title: "Scheduled maintenance", Body: "Sunday 02:00 UTC."}
}

func TestAValidDraftIsAccepted(t *testing.T) {
	got, err := validateCreate(good())
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if got.Severity != domain.SeverityInfo {
		t.Errorf("Severity = %q, want info by default", got.Severity)
	}
	// UNPUBLISHED by default. Authoring and sending are different acts, and a
	// create that published by default would make every typo a broadcast.
	if got.IsPublished {
		t.Error("a new announcement was published by default")
	}
}

func TestTitleAndBodyAreRequired(t *testing.T) {
	for name, mutate := range map[string]func(*CreateInput){
		"empty title":      func(c *CreateInput) { c.Title = "" },
		"whitespace title": func(c *CreateInput) { c.Title = "   " },
		"empty body":       func(c *CreateInput) { c.Body = "" },
		"whitespace body":  func(c *CreateInput) { c.Body = " \n " },
		"title over 200":   func(c *CreateInput) { c.Title = strings.Repeat("a", 201) },
	} {
		t.Run(name, func(t *testing.T) {
			in := good()
			mutate(&in)
			if _, err := validateCreate(in); err == nil {
				t.Errorf("%s was accepted", name)
			} else if !errors.Is(err, ErrRefused) {
				t.Errorf("want ErrRefused, got %v", err)
			}
		})
	}
}

func TestAnUnknownSeverityIsRefusedRatherThanDefaulted(t *testing.T) {
	// The column has a CHECK constraint, so defaulting would turn an operator's
	// typo into a database error at INSERT — a 500 for what is a 422.
	in := good()
	in.Severity = "critical"
	if _, err := validateCreate(in); err == nil {
		t.Error("severity 'critical' was accepted; the schema permits only four values")
	}
}

func TestEverySeverityTheSchemaPermitsIsAccepted(t *testing.T) {
	for _, s := range []string{"info", "warning", "maintenance", "incident"} {
		in := good()
		in.Severity = s
		if _, err := validateCreate(in); err != nil {
			t.Errorf("severity %q was refused: %v", s, err)
		}
	}
}

func TestAWindowThatEndsBeforeItStartsIsRefused(t *testing.T) {
	// It would store fine and match nothing, so the operator would see a
	// successful send and no banner, with nothing to explain the difference.
	start := time.Now().Add(2 * time.Hour)
	end := start.Add(-1 * time.Hour)
	in := good()
	in.StartsAt, in.EndsAt = &start, &end

	if _, err := validateCreate(in); err == nil {
		t.Error("an end before the start was accepted")
	}
}

func TestAnOpenEndedWindowIsAllowed(t *testing.T) {
	start := time.Now().Add(time.Hour)
	in := good()
	in.StartsAt = &start
	got, err := validateCreate(in)
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if got.EndsAt != nil {
		t.Error("an absent end date became a value")
	}
}

// Targeting is passed through unparsed. The schema calls audience_filter
// "intentionally permissive so we can grow filters without a migration", and
// validating its shape here would be that migration.
func TestTargetingIsCarriedThroughUnchanged(t *testing.T) {
	in := good()
	in.AudienceFilter = map[string]any{"products": []any{"mark8ly"}, "statuses": []any{"trialing"}}

	got, err := validateCreate(in)
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if len(got.AudienceFilter) != 2 {
		t.Errorf("filter = %v, want both keys carried", got.AudienceFilter)
	}
}

func TestAnAbsentFilterBecomesAnEmptyObjectAndNotNull(t *testing.T) {
	// The column is NOT NULL DEFAULT '{}'. A nil map would insert NULL and the
	// read query's `audience_filter->'products' IS NULL` branch would then treat
	// it as untargeted — which is right, but by accident rather than by design.
	got, err := validateCreate(good())
	if err != nil {
		t.Fatalf("validateCreate: %v", err)
	}
	if got.AudienceFilter == nil {
		t.Error("an absent filter stayed nil; it must be an empty object")
	}
}

func TestPublishingIsAnExplicitChoiceOnUpdate(t *testing.T) {
	// Nil means "leave alone" everywhere in an update, including publication.
	// An update that silently published on any edit would make correcting a
	// typo a send.
	got, err := validateUpdate(UpdateInput{})
	if err != nil {
		t.Fatalf("validateUpdate: %v", err)
	}
	if got.IsPublished != nil {
		t.Error("an update with no publication field would have changed it")
	}
}

func TestAnUpdateCanClearTheEndDateAndCanLeaveItAlone(t *testing.T) {
	// The two are different intentions and must not share a representation.
	cleared, err := validateUpdate(UpdateInput{EndsAtSet: true})
	if err != nil {
		t.Fatalf("validateUpdate: %v", err)
	}
	if !cleared.EndsAtSet || cleared.EndsAt != nil {
		t.Errorf("clearing the end date did not survive validation: %+v", cleared)
	}

	untouched, err := validateUpdate(UpdateInput{})
	if err != nil {
		t.Fatalf("validateUpdate: %v", err)
	}
	if untouched.EndsAtSet {
		t.Error("an update that said nothing about the end date would have cleared it")
	}
}
