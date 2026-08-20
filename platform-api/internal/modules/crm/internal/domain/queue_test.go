package domain_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/crm/internal/domain"
)

// The bounds are the contract with apps/console/lib/db/crm-filters.ts. They are
// pinned here rather than left to the SQL tests because a band edge that drifts
// by one still produces a working query — it just answers a different question
// from the one the filter bar's label promises.
func TestTheFollowerBandsCarryTheConsolesBounds(t *testing.T) {
	for _, tc := range []struct {
		band     domain.FollowerBand
		min, max int
	}{
		{domain.FollowersUnder1k, 0, 999},
		{domain.Followers1kTo10k, 1000, 9999},
		{domain.FollowersOver10k, 10000, domain.MaxUnbounded},
	} {
		bounds, ok := tc.band.Bounds()
		if !ok {
			t.Fatalf("%s has no bounds", tc.band)
		}
		if bounds.Min != tc.min || bounds.Max != tc.max {
			t.Errorf("%s = {%d, %d}, want {%d, %d}", tc.band, bounds.Min, bounds.Max, tc.min, tc.max)
		}
	}
}

// The bands are keyed by the console's own identifiers, so the console's
// translation is a pass-through on this axis and only ABSENCE needs mapping.
func TestTheBandNamesAreTheConsolesKeys(t *testing.T) {
	for _, name := range []string{"under1k", "k1to10k", "over10k"} {
		if _, err := domain.ParseFollowerBand(name); err != nil {
			t.Errorf("ParseFollowerBand(%q): %v", name, err)
		}
	}
}

// The decision this module is built around: the console's sentinels are not
// values here. If one ever parses as a band or a stage, the sentinel has leaked
// onto the contract and Task 4's query grammar has become decoration.
func TestTheConsolesSentinelsAreNotValues(t *testing.T) {
	for _, sentinel := range []string{"__unassigned__", "__unknown__", "__none__"} {
		if _, err := domain.ParseFollowerBand(sentinel); err == nil {
			t.Errorf("ParseFollowerBand(%q) was accepted as a band", sentinel)
		}
		if _, err := domain.ParseStage(sentinel); err == nil {
			t.Errorf("ParseStage(%q) was accepted as a stage", sentinel)
		}
		// And a sentinel arriving as an ordinary product name stays an
		// ordinary product name — the reason a state beats a magic string.
		filter := domain.Filter{Product: domain.Is(sentinel)}
		if err := filter.Validate(); err != nil {
			t.Errorf("Filter{Product: Is(%q)}.Validate(): %v", sentinel, err)
		}
		if filter.Product.IsUnset() {
			t.Errorf("Is(%q) was read as unset", sentinel)
		}
	}
}

func TestMatchDistinguishesAbsentFromUnsetFromAValue(t *testing.T) {
	for _, tc := range []struct {
		name         string
		match        domain.Match
		any_, unset_ bool
		value        string
	}{
		{"any", domain.Any(), true, false, ""},
		{"unset", domain.Unset(), false, true, ""},
		{"value", domain.Is("mark8ly"), false, false, "mark8ly"},
		// The collapse Is documents: an empty filter and no filter are one
		// state, because "product equals the empty string" is not a question
		// this schema can answer.
		{"empty value is any", domain.Is(""), true, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.match.IsAny() != tc.any_ {
				t.Errorf("IsAny() = %v, want %v", tc.match.IsAny(), tc.any_)
			}
			if tc.match.IsUnset() != tc.unset_ {
				t.Errorf("IsUnset() = %v, want %v", tc.match.IsUnset(), tc.unset_)
			}
			if tc.match.Value() != tc.value {
				t.Errorf("Value() = %q, want %q", tc.match.Value(), tc.value)
			}
		})
	}
}

func TestValidateRefusesWhatTheSQLCouldNotAnswerHonestly(t *testing.T) {
	for _, tc := range []struct {
		name   string
		filter domain.Filter
		want   string
	}{
		{"unknown stage", domain.Filter{Stage: domain.Stage("closed")}, "stage"},
		{"unknown follower band", domain.Filter{Followers: domain.Is("under10")}, "followers"},
		{"country is not alpha-2", domain.Filter{Country: domain.Is("India")}, "country"},
		// Lower case is refused rather than upper-cased. crm_organisations.country
		// holds what @tesserix/crm-country returns, which is upper case, so "in"
		// would match nothing and say nothing — the one silent success worth a 400.
		{"country is lower case", domain.Filter{Country: domain.Is("in")}, "country"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.filter.Validate()
			if err == nil {
				t.Fatalf("Validate() accepted %+v", tc.filter)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Validate() = %v; the message does not name %q", err, tc.want)
			}
		})
	}
}

func TestValidateAcceptsUnsetOnEveryNullableAxis(t *testing.T) {
	filter := domain.Filter{
		Product:   domain.Unset(),
		Country:   domain.Unset(),
		Followers: domain.Unset(),
		Stage:     domain.StageContacted,
		Owner:     "mahesh",
	}
	if err := filter.Validate(); err != nil {
		t.Fatalf("Validate(): %v", err)
	}
}

func TestOnlyWonAndLostAreTerminal(t *testing.T) {
	for _, s := range []domain.Stage{domain.StageNew, domain.StageContacted, domain.StageQualified} {
		if s.Terminal() {
			t.Errorf("%s is terminal", s)
		}
	}
	for _, s := range []domain.Stage{domain.StageWon, domain.StageLost} {
		if !s.Terminal() {
			t.Errorf("%s is not terminal", s)
		}
	}
}
