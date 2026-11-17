// Package featureflags owns platform-console release flag management.
package featureflags

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const flagPrefix = "helivanta.release."

var flagKey = regexp.MustCompile(`^[a-z][a-z_]{0,63}$`)
var errInvalidCatalogue = errors.New("release catalogue is unavailable or invalid")

type definition struct {
	Key          string   `json:"key"`
	Owner        string   `json:"owner"`
	Eligible     bool     `json:"eligible"`
	Dependencies []string `json:"dependencies"`
}
type catalogue struct {
	Version       int          `json:"version"`
	PolicyVersion string       `json:"policy_version"`
	Capabilities  []definition `json:"capabilities"`
}
type flag struct {
	Key                string   `json:"key"`
	Title              string   `json:"title"`
	Description        string   `json:"description"`
	Group              string   `json:"group"`
	Enabled            bool     `json:"enabled"`
	Eligible           bool     `json:"eligible"`
	Available          bool     `json:"available"`
	Dependencies       []string `json:"dependencies"`
	BlockedBy          []string `json:"blocked_by"`
	ImpactWhenEnabled  []string `json:"impact_when_enabled"`
	ImpactWhenDisabled []string `json:"impact_when_disabled"`
}

func parseCatalogue(data []byte) (catalogue, error) {
	var c catalogue
	if json.Unmarshal(data, &c) != nil || c.Version != 1 || c.PolicyVersion == "" || len(c.Capabilities) == 0 || len(c.Capabilities) > 100 {
		return c, errInvalidCatalogue
	}
	known := map[string]definition{}
	for _, d := range c.Capabilities {
		if !flagKey.MatchString(d.Key) || d.Owner == "" {
			return c, errInvalidCatalogue
		}
		if _, ok := known[d.Key]; ok {
			return c, errInvalidCatalogue
		}
		known[d.Key] = d
	}
	visited := map[string]bool{}
	var visit func(string, map[string]bool) error
	visit = func(key string, path map[string]bool) error {
		if path[key] {
			return errInvalidCatalogue
		}
		if visited[key] {
			return nil
		}
		d, ok := known[key]
		if !ok {
			return errInvalidCatalogue
		}
		next := map[string]bool{}
		for k, v := range path {
			next[k] = v
		}
		next[key] = true
		seen := map[string]bool{}
		for _, dep := range d.Dependencies {
			target, ok := known[dep]
			if !ok || seen[dep] || (d.Eligible && !target.Eligible) {
				return errInvalidCatalogue
			}
			seen[dep] = true
			if err := visit(dep, next); err != nil {
				return err
			}
		}
		visited[key] = true
		return nil
	}
	for key := range known {
		if err := visit(key, map[string]bool{}); err != nil {
			return c, err
		}
	}
	return c, nil
}

func availability(c catalogue, enabled map[string]bool) map[string]bool {
	definitions := map[string]definition{}
	available := map[string]bool{}
	for _, d := range c.Capabilities {
		definitions[d.Key] = d
	}
	var resolve func(string) bool
	resolve = func(key string) bool {
		if value, ok := available[key]; ok {
			return value
		}
		d := definitions[key]
		value := enabled[key] && d.Eligible
		for _, dep := range d.Dependencies {
			value = resolve(dep) && value
		}
		available[key] = value
		return value
	}
	for _, d := range c.Capabilities {
		resolve(d.Key)
	}
	return available
}

func evaluate(c catalogue, enabled map[string]bool) ([]flag, error) {
	if len(enabled) != len(c.Capabilities) {
		return nil, errors.New("provider catalogue does not match the released product")
	}
	for _, d := range c.Capabilities {
		if _, ok := enabled[d.Key]; !ok {
			return nil, errors.New("provider feature is missing")
		}
	}
	current := availability(c, enabled)
	impact := func(key string, value bool) []string {
		proposed := map[string]bool{}
		for k, v := range enabled {
			proposed[k] = v
		}
		proposed[key] = value
		result := availability(c, proposed)
		changed := []string{}
		for _, d := range c.Capabilities {
			if d.Key != key && result[d.Key] != current[d.Key] {
				changed = append(changed, d.Key)
			}
		}
		return changed
	}
	out := make([]flag, 0, len(c.Capabilities))
	for _, d := range c.Capabilities {
		title, description, group := presentation(d)
		dependencies := append([]string{}, d.Dependencies...)
		blocked := []string{}
		for _, dep := range d.Dependencies {
			if !current[dep] {
				blocked = append(blocked, dep)
			}
		}
		out = append(out, flag{Key: d.Key, Title: title, Description: description, Group: group, Enabled: enabled[d.Key], Eligible: d.Eligible, Available: current[d.Key], Dependencies: dependencies, BlockedBy: blocked, ImpactWhenEnabled: impact(d.Key, true), ImpactWhenDisabled: impact(d.Key, false)})
	}
	return out, nil
}

func presentation(d definition) (string, string, string) {
	text := map[string][2]string{
		"onboarding":             {"Workspace onboarding", "Hospital and independent-pharmacy signup, verification and owner setup."},
		"team_accounts":          {"Staff accounts and permissions", "Invite team members and manage their permission-assignment workflows. This flag grants no roles."},
		"staff_core":             {"Staff records and reviews", "Staff directory, reviewed identity/employment links and core credentials."},
		"department_teams":       {"Department teams", "Department structure, team membership and posting preparation/review."},
		"pharmacy_setup":         {"PharmaConnect setup", "Pharmacy organizations, branches and required setup/licensing evidence."},
		"pharmacy_staff":         {"Pharmacy staff", "Hospital-employed and independent-pharmacy staff, account links and credential evidence."},
		"pharmacy_catalogue":     {"Medicine catalogue", "PharmaConnect product and medicine catalogue workflows."},
		"pharmacy_stock":         {"Stock and receiving", "Inventory and stock workflows; enabled only after their approved release."},
		"pharmacy_prescriptions": {"Prescriptions", "Prescription-related pharmacy workflows and professional-authority checks."},
		"pharmacy_returns":       {"Returns", "Pharmacy return and stock-correction workflows."},
		"pharmacy_reports":       {"Pharmacy reports", "PharmaConnect operational reporting."},
		"pharmacy_counter":       {"Pharmacy counter", "Counter workflows depend on all declared pharmacy capabilities."},
		"pharmacy_payables":      {"Pharmacy payables", "Pharmacy financial and payable workflows."},
		"workforce_scheduling":   {"Scheduling and leave", "Attendance, shifts, rosters, leave, overtime and duty exchanges."},
		"workforce_payroll":      {"Payroll and benefits", "Staff payroll setup and benefits."},
		"workforce_advanced":     {"Advanced Staff tools", "Advanced workforce workflows, including credential reminders and reminder policy."},
		"supplier_collaboration": {"Supplier collaboration", "Supplier staff, partner teams and cross-organization operating workflows."},
		"clinical":               {"Clinical workflows", "Clinical product availability; clinical authority remains separately enforced."},
		"lab":                    {"Laboratory", "Laboratory product availability and its existing scope/permission checks."},
		"emergency":              {"Emergency", "Emergency product availability and its existing scope/permission checks."},
		"billing_workspace":      {"Hospital finance", "Hospital billing workspace availability."},
		"unreleased":             {"Unclassified functionality", "Not released. New functionality must be classified and reviewed before activation."},
	}
	title := strings.ReplaceAll(d.Key, "_", " ")
	description := fmt.Sprintf("Release availability for %s. Application authorization remains required.", title)
	if p, ok := text[d.Key]; ok {
		title, description = p[0], p[1]
	}
	group := "Other product areas"
	switch {
	case d.Key == "team_accounts" || d.Owner == "workforce":
		group = "Staff"
	case d.Owner == "pharmacy":
		group = "PharmaConnect"
	case d.Key == "onboarding":
		group = "Foundation"
	case d.Key == "supplier_collaboration":
		group = "Supplier collaboration"
	}
	return title, description, group
}
