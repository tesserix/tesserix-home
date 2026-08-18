// Package architecture holds the import-graph rule that keeps the modular
// monolith modular. See internal/modules/doc.go for the rule and the reasoning;
// this file is the machinery that enforces it.
package architecture

import (
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
)

// ModuleRoot is the import-path segment under which domain modules live. A
// module is the first path element after it.
const ModuleRoot = "internal/modules/"

// Violation is one forbidden import: a file in one module importing another.
type Violation struct {
	// File is the offending file, relative to the scanned root.
	File string
	// FromModule is the module the file belongs to.
	FromModule string
	// ToModule is the module it imports.
	ToModule string
	// Import is the full import path, so the message names something the
	// reader can search for rather than a summary they must reconstruct.
	Import string
}

func (v Violation) String() string {
	return fmt.Sprintf(
		"%s: module %q imports module %q (%s)",
		v.File, v.FromModule, v.ToModule, v.Import,
	)
}

// moduleOf returns the module name for a path under ModuleRoot, and whether the
// path is under it at all.
//
// The path may be either a slash-separated file path relative to the scan root
// ("internal/modules/tickets/internal/repository/repo.go") or a full import
// path ("github.com/…/internal/modules/tickets/internal/repository"). Both are
// reduced the same way: find the marker, take the next segment.
func moduleOf(p string) (string, bool) {
	idx := strings.Index(p, ModuleRoot)
	if idx < 0 {
		return "", false
	}
	rest := p[idx+len(ModuleRoot):]
	if rest == "" {
		return "", false
	}
	name, _, _ := strings.Cut(rest, "/")
	if name == "" {
		return "", false
	}
	// A file sitting directly in modules/ — doc.go, for instance — is not a
	// module. Only a directory is, and a bare filename still carries its
	// extension at this point.
	if strings.HasSuffix(name, ".go") {
		return "", false
	}
	return name, true
}

// Check walks fsys and reports every cross-module import.
//
// It parses imports only, so it neither builds nor type-checks, and it holds no
// dependency beyond the standard library — which matters because this runs on
// every CI run and the one thing it must never do is fail for a reason
// unrelated to what it checks.
//
// Test files are scanned along with everything else. A module's test reaching
// into a sibling is the same coupling as its production code doing so, and
// exempting tests is how the first exception gets made.
func Check(fsys fs.FS) ([]Violation, error) {
	var violations []Violation
	fset := token.NewFileSet()

	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Nothing under a vendor tree is ours to police, and walking it
			// would be slow and noisy.
			if d.Name() == "vendor" || d.Name() == "testdata" || d.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		from, ok := moduleOf(p)
		if !ok {
			return nil
		}

		src, err := fs.ReadFile(fsys, p)
		if err != nil {
			return fmt.Errorf("read %s: %w", p, err)
		}
		// ImportsOnly: the rule is about the import graph, and parsing bodies
		// would make a file that does not compile fail this check for the
		// wrong reason.
		file, err := parser.ParseFile(fset, p, src, parser.ImportsOnly)
		if err != nil {
			return fmt.Errorf("parse %s: %w", p, err)
		}

		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return fmt.Errorf("%s: malformed import %s: %w", p, spec.Path.Value, err)
			}
			to, ok := moduleOf(imported)
			if !ok || to == from {
				continue
			}
			violations = append(violations, Violation{
				File:       path.Clean(p),
				FromModule: from,
				ToModule:   to,
				Import:     imported,
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Deterministic order, so a CI failure reads the same way twice and a diff
	// of two runs means something.
	sort.Slice(violations, func(i, j int) bool {
		a, b := violations[i], violations[j]
		if a.File != b.File {
			return a.File < b.File
		}
		return a.Import < b.Import
	})
	return violations, nil
}
