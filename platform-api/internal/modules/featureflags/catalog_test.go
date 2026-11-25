package featureflags

import (
	"slices"
	"strings"
	"testing"
)

func TestStaffRecoveryCatalogueExplainsTheControlWithoutEnablingIt(t *testing.T) {
	c, err := parseCatalogue([]byte(`{"version":1,"policy_version":"2026-11-19-r1","capabilities":[{"key":"team_accounts","owner":"platform","eligible":true,"dependencies":[]},{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":["team_accounts"]},{"key":"staff_mfa_recovery","owner":"workforce","eligible":true,"dependencies":["staff_core","team_accounts"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	flags, err := evaluate(c, map[string]bool{"team_accounts": true, "staff_core": true})
	if err != nil {
		t.Fatal(err)
	}
	recovery := flags[2]
	if recovery.Key != "staff_mfa_recovery" || recovery.Title != "Staff authenticator recovery" || recovery.Group != "Staff" {
		t.Fatalf("unclear recovery control: %+v", recovery)
	}
	for _, detail := range []string{"reviewed account link", "reason", "audit", "replacement enrollment"} {
		if !strings.Contains(recovery.Description, detail) {
			t.Fatalf("recovery description omits %q", detail)
		}
	}
	if recovery.Provisioned || recovery.Enabled || recovery.Available || !recovery.Eligible || !slices.Equal(recovery.Dependencies, []string{"staff_core", "team_accounts"}) {
		t.Fatalf("catalogue presentation changed recovery admission: %+v", recovery)
	}
}

func TestCatalogueDependencyClosureAndReleaseCeiling(t *testing.T) {
	catalogue, err := parseCatalogue([]byte(`{"version":1,"policy_version":"r1","capabilities":[{"key":"team_accounts","owner":"platform","eligible":true,"dependencies":[]},{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":["team_accounts"]},{"key":"workforce_payroll","owner":"workforce","eligible":false,"dependencies":["staff_core"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	flags, err := evaluate(catalogue, map[string]bool{"team_accounts": false, "staff_core": true, "workforce_payroll": true})
	if err != nil {
		t.Fatal(err)
	}
	if flags[1].Available || flags[2].Available || !flags[1].Enabled || flags[2].Eligible {
		t.Fatalf("unexpected release state: %+v", flags)
	}
	if flags[1].Group != "Staff" || flags[1].Title != "Staff records and reviews" {
		t.Fatalf("unclear presentation: %+v", flags[1])
	}
}

func TestInvalidCatalogueNeverProducesEditableFlags(t *testing.T) {
	for _, source := range []string{
		`{"version":1,"policy_version":"r1","capabilities":[{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":["missing"]}]}`,
		`{"version":1,"policy_version":"r1","capabilities":[{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":["staff_core"]}]}`,
		`{"version":1,"policy_version":"r1","capabilities":[{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":[]},{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":[]}]}`,
		`{"version":2,"policy_version":"r1","capabilities":[]}`,
	} {
		if _, err := parseCatalogue([]byte(source)); err == nil {
			t.Fatalf("accepted invalid catalogue %s", source)
		}
	}
}

func TestWritePlanRequiresFreshReleasedAndUnblockedFeature(t *testing.T) {
	current := view{Revision: "revision-one", Flags: []flag{{Provisioned: true, Key: "team_accounts", Enabled: false, Eligible: true}, {Provisioned: true, Key: "staff_core", Enabled: false, Eligible: true, BlockedBy: []string{"team_accounts"}}, {Provisioned: true, Key: "workforce_payroll", Enabled: false, Eligible: false}}}
	for _, tc := range []struct {
		key, revision string
		enabled       bool
		want          int
	}{
		{"staff_core", "revision-one", true, 409},
		{"workforce_payroll", "revision-one", true, 422},
		{"team_accounts", "old-revision", true, 409},
		{"unknown", "revision-one", false, 404},
		{"team_accounts", "revision-one", true, 0},
		{"workforce_payroll", "revision-one", false, 0},
	} {
		err := validateChange(current, change{Key: tc.key, Enabled: tc.enabled, ExpectedRevision: tc.revision, Reason: "Approved release control"})
		if tc.want == 0 {
			if err != nil {
				t.Fatal(err)
			}
		} else if err == nil || err.Status != tc.want {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
}

func TestPrerequisiteConfirmationUsesEffectiveImpact(t *testing.T) {
	c, err := parseCatalogue([]byte(`{"version":1,"policy_version":"r1","capabilities":[{"key":"team_accounts","owner":"platform","eligible":true,"dependencies":[]},{"key":"staff_core","owner":"workforce","eligible":true,"dependencies":["team_accounts"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	flags, err := evaluate(c, map[string]bool{"team_accounts": true, "staff_core": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(flags[0].ImpactWhenDisabled) != 1 || flags[0].ImpactWhenDisabled[0] != "staff_core" {
		t.Fatalf("missing dependent impact: %+v", flags[0])
	}
	flags, err = evaluate(c, map[string]bool{"team_accounts": false, "staff_core": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(flags[0].ImpactWhenEnabled) != 1 || flags[0].ImpactWhenEnabled[0] != "staff_core" {
		t.Fatalf("missing resume impact: %+v", flags[0])
	}
}

func TestPilotEligibilityIsLabelledAndCannotBypassDependencies(t *testing.T) {
	c, err := parseCatalogue([]byte(`{"version":1,"policy_version":"pilot","capabilities":[{"key":"pharmacy_stock","owner":"pharmacy","eligible":false,"pilot_eligible":true,"dependencies":[]},{"key":"pharmacy_counter","owner":"pharmacy","eligible":false,"pilot_eligible":true,"dependencies":["pharmacy_stock"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	flags, err := evaluate(c, map[string]bool{"pharmacy_stock": false, "pharmacy_counter": true})
	if err != nil {
		t.Fatal(err)
	}
	if !flags[1].PilotOnly || !flags[1].Eligible || flags[1].Available {
		t.Fatalf("unsafe pilot state: %+v", flags[1])
	}
	flags, err = evaluate(c, map[string]bool{"pharmacy_stock": true, "pharmacy_counter": true})
	if err != nil || !flags[1].Available || !flags[1].PilotOnly {
		t.Fatalf("pilot not reflected: %+v %v", flags, err)
	}
	if !strings.Contains(flags[1].Description, "approved pilot tenants") {
		t.Fatal("scope missing from description")
	}
}
