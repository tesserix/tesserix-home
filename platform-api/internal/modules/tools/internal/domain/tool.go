// Package domain is the tools directory's rules: what a tool must look like
// before it can be stored, and what a group's key may be.
//
// No SQL and no HTTP. The same validation runs whether a row arrives from an
// operator's form or a product's API call, and it runs before either reaches
// a transaction.
package domain

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// SubdomainPattern is the API's copy of migration 0031's CHECK constraint.
//
// Duplicated deliberately, and the duplication is the point of the test that
// asserts both refuse the same strings: the constraint is the guarantee, and
// this is the one that can say WHY in a sentence the caller can act on. A
// 23514 from Postgres names a constraint; this names the rule.
var SubdomainPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

// groupKeyPattern is narrower than a DNS label: a key is referenced by every
// tool in the group, so it is an identifier rather than prose.
var groupKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

const (
	maxName      = 80
	maxPurpose   = 200
	maxNote      = 200
	maxSubdomain = 63
	maxLabel     = 60
)

// ErrInvalid is every refusal this package makes. The service turns it into a
// 422; the handler never inspects it further, because the message is the part
// a caller can act on.
var ErrInvalid = errors.New("the tool is not valid")

// Tool is a directory entry as a caller supplied it.
//
// SortOrder is a pointer because absent and zero are different: absent means
// "put it at the end of its group", and zero is a legitimate first position.
type Tool struct {
	Name      string
	Subdomain string
	Purpose   string
	Note      *string
	GroupKey  string
	SortOrder *int
}

// Normalise trims, lower-cases the subdomain and collapses a blank note to
// absence.
//
// Called BEFORE Validate, always: a note of three spaces is not an over-long
// note, and refusing it for its length would name the wrong problem.
func (t Tool) Normalise() Tool {
	t.Name = strings.TrimSpace(t.Name)
	t.Subdomain = strings.ToLower(strings.TrimSpace(t.Subdomain))
	t.Purpose = strings.TrimSpace(t.Purpose)
	t.GroupKey = strings.TrimSpace(t.GroupKey)
	if t.Note != nil {
		trimmed := strings.TrimSpace(*t.Note)
		if trimmed == "" {
			t.Note = nil
		} else {
			t.Note = &trimmed
		}
	}
	return t
}

// Validate answers the first thing wrong with the tool, or nil.
//
// First rather than all of them: the console has no form yet, so there is no
// field-by-field renderer to feed, and a caller fixing one thing at a time is
// the shape every other module in this service assumes.
func (t Tool) Validate() error {
	if t.Name == "" {
		return fmt.Errorf("%w: a name is required", ErrInvalid)
	}
	if len(t.Name) > maxName {
		return fmt.Errorf("%w: a name may be at most %d characters", ErrInvalid, maxName)
	}
	if len(t.Subdomain) > maxSubdomain || !SubdomainPattern.MatchString(t.Subdomain) {
		return fmt.Errorf(
			"%w: a subdomain must be a single DNS label — lower-case letters, digits and "+
				"hyphens, not starting or ending with a hyphen, at most %d characters. "+
				"It is a label and not a URL because the console derives the host from the "+
				"environment it is running in", ErrInvalid, maxSubdomain)
	}
	if t.Purpose == "" {
		return fmt.Errorf("%w: a purpose is required — it is the one line that tells "+
			"someone who has not used the tool what it is for", ErrInvalid)
	}
	if len(t.Purpose) > maxPurpose {
		return fmt.Errorf("%w: a purpose may be at most %d characters", ErrInvalid, maxPurpose)
	}
	if t.Note != nil && len(*t.Note) > maxNote {
		return fmt.Errorf("%w: a note may be at most %d characters", ErrInvalid, maxNote)
	}
	if t.GroupKey == "" {
		return fmt.Errorf("%w: a group_key is required", ErrInvalid)
	}
	if t.SortOrder != nil && *t.SortOrder < 0 {
		return fmt.Errorf("%w: a sort_order may not be negative", ErrInvalid)
	}
	return nil
}

// Group is a heading, and the vocabulary a Tool's GroupKey must name.
type Group struct {
	Key       string
	Label     string
	SortOrder *int
}

// Normalise trims and lower-cases the key.
func (g Group) Normalise() Group {
	g.Key = strings.ToLower(strings.TrimSpace(g.Key))
	g.Label = strings.TrimSpace(g.Label)
	return g
}

// Validate answers the first thing wrong with the group, or nil.
func (g Group) Validate() error {
	if !groupKeyPattern.MatchString(g.Key) {
		return fmt.Errorf("%w: a group key must start with a lower-case letter and contain "+
			"only lower-case letters, digits and hyphens — every tool in the group "+
			"references it", ErrInvalid)
	}
	if g.Label == "" {
		return fmt.Errorf("%w: a label is required — a group without one renders as a "+
			"blank heading", ErrInvalid)
	}
	if len(g.Label) > maxLabel {
		return fmt.Errorf("%w: a label may be at most %d characters", ErrInvalid, maxLabel)
	}
	if g.SortOrder != nil && *g.SortOrder < 0 {
		return fmt.Errorf("%w: a sort_order may not be negative", ErrInvalid)
	}
	return nil
}
