# Tools Directory In The Database — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the console's internal tools directory is read from `tesserix_admin`
through a new `/v1/platform/tools` module on the Go platform API, editable
without a deploy, with a labelled fallback to the code literal.

**Architecture:** two seeded tables in `tesserix_admin`; a new Go module
`internal/modules/tools/` shaped exactly like `internal/modules/crm/` (kernel
only, no sibling imports, `RouteTable` + `routeCases`, `write.Perform` for
writes); a `server-only` console loader with a `PLATFORM_API_ORIGIN` dual path
whose result is fetched once in the console layout and passed as a plain prop
to both the home cards and the client-side command palette.

**Tech Stack:** Go 1.26, pgx/v5, `net/http` `ServeMux` patterns, Next.js 16
App Router, React 19, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-console-tools-directory-in-db-design.md`

## Global Constraints

- **Migrations are manual.** `0031` is applied to production **before** the PR
  merges. Kargo deploys on merge; `db:migrate` does not ride along.
- **Every route names its capability.** `auth.CapPlatform`, taken from
  `platform.dashboard` in `packages/console-core/src/routes.ts`. Do not invent
  a capability — it would assert a Zitadel role nobody holds and fail closed.
- **A module may not import a sibling module.** `internal/architecture`
  enforces it; test files are not exempt.
- **`StandardResponse` envelope, named payload objects** (`{"tools": [...]}`,
  never a bare array), snake_case, `[]` never `null`.
- **`Idempotency-Key` on every write**, via `internal/platform/idempotency` and
  `write.Perform`.
- **`httpx.RejectUnknownParameters` on every read.**
- **Golden files for success AND each error shape.** Regenerate with
  `go test ./internal/modules/tools/internal/handler/... -update-golden` and
  read the diff before committing.
- **CI lints at `--max-warnings 0`.** An unused symbol fails the build.
- **`tsc` is not a build.** `npx next build` in `apps/console` before merge.
- **Database tests skip silently** without `TESSERIX_TEST_DB_HOST`. Every task
  that runs Go tests confirms **zero skips**.
- Single-line conventional commits. No signatures, no co-author trailers.

**Start every Go test task by starting the throwaway database:**

```bash
docker run -d --name tools-testdb -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:15-alpine
export TESSERIX_TEST_DB_HOST=127.0.0.1 TESSERIX_TEST_DB_PORT=55432 \
       TESSERIX_TEST_DB_USER=postgres TESSERIX_TEST_DB_PASSWORD=test
```

Confirm zero skips with `go test ./... 2>&1 | grep -c SKIP` returning `0`, or
by reading the `-v` output. A "pass" that skipped is not a pass.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `apps/web/db/migrations/0031_platform_tools.sql` | Two tables, constraints, seed of today's 5 groups + 15 tools |
| `platform-api/internal/modules/tools/tools.go` | Module public surface: `Config`, `Register` |
| `platform-api/internal/modules/tools/internal/domain/tool.go` | Validation and normalisation; no SQL, no HTTP |
| `platform-api/internal/modules/tools/internal/domain/tool_test.go` | Domain unit tests (no database) |
| `platform-api/internal/modules/tools/internal/repository/tools.go` | All SQL |
| `platform-api/internal/modules/tools/internal/repository/tools_test.go` | Repository tests against a real Postgres |
| `platform-api/internal/modules/tools/internal/service/service.go` | Operations over the pool; `write.Perform` transaction scripts |
| `platform-api/internal/modules/tools/internal/service/wire.go` | Wire types — the snake_case payloads |
| `platform-api/internal/modules/tools/internal/handler/handler.go` | HTTP surface, `RouteTable`, status mapping |
| `platform-api/internal/modules/tools/internal/handler/handler_test.go` | Harness + contract tests |
| `platform-api/internal/modules/tools/internal/handler/capability_test.go` | `routeCases` + the refusal/success pair |
| `platform-api/internal/modules/tools/internal/handler/golden_test.go` | Golden harness and the golden test |
| `apps/console/lib/tools-directory.ts` | `server-only` dual-path loader |
| `apps/console/lib/tools-directory.test.ts` | Loader tests, both branches |

**Modify:**

| Path | Change |
|---|---|
| `platform-api/cmd/server/main.go:117` | Register the module |
| `apps/console/app/(console)/page.tsx:25` | Await the loader, pass the directory down |
| `apps/console/components/internal-tools.tsx` | Take rows as props; render the fallback label |
| `apps/console/lib/search.ts:147` | `toolEntries(baseDomain, tools)` |
| `apps/console/components/nav/command-palette.tsx:76` | Take `tools` as a prop |
| `apps/console/components/nav/console-header.tsx:20` | Thread `tools` through |
| `apps/console/app/(console)/layout.tsx:33` | Fetch once, pass down |
| `packages/console-core/src/tools.test.ts` | Coverage tests → integrity tests |

---

## Task 1: The migration and the repository read

**Files:**
- Create: `apps/web/db/migrations/0031_platform_tools.sql`
- Create: `platform-api/internal/modules/tools/internal/repository/tools.go`
- Test: `platform-api/internal/modules/tools/internal/repository/tools_test.go`

**Interfaces:**
- Consumes: `internal/platform/testdb` (`testdb.New(t) *pgxpool.Pool`), which
  applies every file in `apps/web/db/migrations` to a fresh database — so
  `0031` reaches Go tests automatically once it exists.
- Produces: `repository.Tool`, `repository.Group`, `repository.ListTools(ctx,
  q Queryer) ([]Tool, error)`, `repository.ListGroups(ctx, q Queryer)
  ([]Group, error)`, `repository.Queryer`.

- [ ] **Step 1: Write the failing repository test**

Create `platform-api/internal/modules/tools/internal/repository/tools_test.go`:

```go
package repository_test

import (
	"context"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The seed is part of the migration rather than a fixture, because the
// directory must render identically on the day of cutover. These assert the
// seed itself, so a migration that created the tables and forgot the rows
// fails here rather than on the home page.

func TestTheSeedCarriesTodaysDirectory(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	groups, err := repository.ListGroups(ctx, pool)
	if err != nil {
		t.Fatalf("listing groups: %v", err)
	}
	wantGroups := []string{"identity", "observability", "delivery", "cost", "reference"}
	if len(groups) != len(wantGroups) {
		t.Fatalf("got %d groups, want %d: %+v", len(groups), len(wantGroups), groups)
	}
	// Order is the contract: TOOL_GROUPS is a display order, and identity is
	// first because it gates everything else.
	for i, want := range wantGroups {
		if groups[i].Key != want {
			t.Errorf("group %d = %q, want %q — sort_order is the display order", i, groups[i].Key, want)
		}
	}

	tools, err := repository.ListTools(ctx, pool)
	if err != nil {
		t.Fatalf("listing tools: %v", err)
	}
	if len(tools) != 15 {
		t.Fatalf("got %d tools, want the 15 in tools.ts: %+v", len(tools), tools)
	}
	if tools[0].Subdomain != "auth" || tools[0].Name != "Zitadel" {
		t.Errorf("first tool = %s/%s, want Zitadel/auth", tools[0].Name, tools[0].Subdomain)
	}
}

func TestTheTwoToolsWithNotesKeepThem(t *testing.T) {
	pool := testdb.New(t)

	tools, err := repository.ListTools(context.Background(), pool)
	if err != nil {
		t.Fatalf("listing tools: %v", err)
	}

	noted := map[string]string{}
	for _, tool := range tools {
		if tool.Note != nil {
			noted[tool.Subdomain] = *tool.Note
		}
	}
	// Exactly the two that carry one in tools.ts. A note is present only where
	// there is something real to say, and the seed must not invent any.
	if len(noted) != 2 {
		t.Errorf("got %d notes, want 2 (secret-service and argocd): %+v", len(noted), noted)
	}
	if _, ok := noted["secret-service"]; !ok {
		t.Error("secret-service lost its separate-login note")
	}
	if _, ok := noted["argocd"]; !ok {
		t.Error("argocd lost its outside-the-gateway note")
	}
}

func TestASubdomainThatIsNotADnsLabelIsRefused(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	// The CHECK is what keeps toolUrl's host derivation honest. Without it a
	// row could carry a whole URL and link operators anywhere.
	for _, bad := range []string{
		"https://grafana.tesserix.app",
		"grafana.tesserix.app",
		"Grafana",
		"-leading",
		"trailing-",
		"",
	} {
		_, err := pool.Exec(ctx,
			`INSERT INTO platform_tools (name, subdomain, purpose, group_key, sort_order)
			 VALUES ('x', $1, 'x', 'reference', 99)`, bad)
		if err == nil {
			t.Errorf("subdomain %q was accepted; it must be a single DNS label", bad)
		}
	}
}

func TestAToolInAnUndeclaredGroupIsRefused(t *testing.T) {
	pool := testdb.New(t)

	// This is the foreign key standing in for the ToolGroup union type that
	// moving groups into the database gives up.
	_, err := pool.Exec(context.Background(),
		`INSERT INTO platform_tools (name, subdomain, purpose, group_key, sort_order)
		 VALUES ('x', 'x', 'x', 'no-such-group', 99)`)
	if err == nil {
		t.Fatal("a tool in an undeclared group was accepted; the FK is missing")
	}
}

func TestADuplicateSubdomainIsRefused(t *testing.T) {
	pool := testdb.New(t)

	_, err := pool.Exec(context.Background(),
		`INSERT INTO platform_tools (name, subdomain, purpose, group_key, sort_order)
		 VALUES ('Another Zitadel', 'auth', 'x', 'identity', 99)`)
	if err == nil {
		t.Fatal("a duplicate subdomain was accepted; the UNIQUE constraint is missing")
	}
}

func TestAGroupWithToolsCannotBeDeleted(t *testing.T) {
	pool := testdb.New(t)

	_, err := pool.Exec(context.Background(),
		`DELETE FROM platform_tool_groups WHERE key = 'identity'`)
	if err == nil {
		t.Fatal("a group with tools was deleted; ON DELETE RESTRICT is missing")
	}
}
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
cd platform-api && go test ./internal/modules/tools/... -v
```

Expected: a build failure — the `repository` package does not exist. Not a
skip. If it skips, `TESSERIX_TEST_DB_HOST` is unset and nothing was proved.

- [ ] **Step 3: Write the migration**

Create `apps/web/db/migrations/0031_platform_tools.sql`:

```sql
-- The internal tools directory, moved out of packages/console-core/src/tools.ts.
--
-- Two tables rather than one because #318 moves the group vocabulary too. The
-- foreign key below is what replaces the `ToolGroup` union type: a tool in an
-- undeclared group cannot exist, and a group with tools cannot be deleted.
--
-- What the code KEEPS is host derivation. `subdomain` is a single DNS label,
-- never a URL, so `toolUrl(tool, baseDomain)` still decides which environment
-- a link points at — a row carrying https://grafana.tesserix.app would send a
-- dev console's operators to production, permanently and invisibly. The CHECK
-- is what makes that unstorable rather than merely discouraged.

CREATE TABLE IF NOT EXISTS platform_tool_groups (
    key        text PRIMARY KEY,
    label      text NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_tools (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    subdomain  text NOT NULL UNIQUE
               CONSTRAINT platform_tools_subdomain_is_a_dns_label
               CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND length(subdomain) <= 63),
    purpose    text NOT NULL,
    note       text,
    group_key  text NOT NULL REFERENCES platform_tool_groups (key) ON DELETE RESTRICT,
    sort_order integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_tools_group_order
    ON platform_tools (group_key, sort_order);

-- The seed is today's directory, in today's order, so the rendered page is
-- unchanged on the day of cutover.

INSERT INTO platform_tool_groups (key, label, sort_order) VALUES
    ('identity',      'Identity and secrets', 1),
    ('observability', 'Observability',        2),
    ('delivery',      'Delivery',             3),
    ('cost',          'Cost',                 4),
    ('reference',     'Reference',            5)
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_tools (name, subdomain, purpose, note, group_key, sort_order) VALUES
    ('Zitadel', 'auth',
     'Identity platform. Operators, organisations, projects and roles.',
     NULL, 'identity', 1),
    ('Secret service', 'secret-service',
     'Admin console for OpenBao and GCP Secret Manager, and which namespaces may read each secret.',
     'Separate login — independent of the platform''s identity on purpose.', 'identity', 2),
    ('Grafana', 'grafana',
     'Dashboards and charts over the metrics pipeline.',
     NULL, 'observability', 1),
    ('Observability', 'observability',
     'Tesserix''s own OTel trace and log explorer.',
     NULL, 'observability', 2),
    ('Prometheus', 'prometheus',
     'Raw metric queries, when a Grafana panel is not enough.',
     NULL, 'observability', 3),
    ('Alertmanager', 'alertmanager',
     'Firing alerts, silences and routing.',
     NULL, 'observability', 4),
    ('Kibana', 'kibana',
     'Full-text log search across workloads, when you have a message but no trace.',
     NULL, 'observability', 5),
    ('OpenPanel', 'analytics',
     'Self-hosted product analytics — page views and events.',
     NULL, 'observability', 6),
    ('ArgoCD', 'argocd',
     'What is deployed, and whether it matches git.',
     'Reached outside the Istio gateway; its own login.', 'delivery', 1),
    ('Kargo', 'kargo',
     'Promotes images between stages. Where a stuck rollout shows up.',
     NULL, 'delivery', 2),
    ('Kubecost', 'kubecost',
     'Cluster spend by namespace and workload.',
     NULL, 'cost', 1),
    ('Cost estimator', 'costestimator',
     'Models the cost of a change before making it.',
     NULL, 'cost', 2),
    ('Agentic registry', 'aregistry',
     'Registry for agentic artifacts — skills, tools, MCPs, prompts.',
     NULL, 'reference', 1),
    ('Design system', 'ui',
     'Storybook for @tesserix/web — the components every app is built from.',
     NULL, 'reference', 2),
    ('Docs', 'docs',
     'Engineering documentation.',
     NULL, 'reference', 3)
ON CONFLICT (subdomain) DO NOTHING;
```

**Before writing this, open `packages/console-core/src/tools.ts` and copy the
fifteen `name`, `subdomain` and `purpose` values verbatim.** The block above is
transcribed from it, but the file is the source; a paraphrased `purpose` is a
silent content change to the page.

- [ ] **Step 4: Write the repository**

Create `platform-api/internal/modules/tools/internal/repository/tools.go`:

```go
// Package repository is the tools module's SQL, and the only place it lives.
//
// Under modules/tools/internal/, so only code rooted at modules/tools/ can
// import it.
package repository

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Queryer is what this package needs from a pool or a transaction.
//
// An interface rather than *pgxpool.Pool so the reads work inside
// write.Perform's transaction as well as outside one — a write that answers
// with the row it just changed must read it through the same transaction, or
// it answers with what was there before.
type Queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Tool is one row of the directory.
type Tool struct {
	ID        string
	Name      string
	Subdomain string
	Purpose   string
	// Note is absent for most tools. A pointer rather than a string because
	// "" and "no note" are different things on the wire: the console renders
	// nothing for absence and would render an empty line for "".
	Note      *string
	GroupKey  string
	SortOrder int
}

// Group is one heading, and the vocabulary a Tool's GroupKey must name.
type Group struct {
	Key       string
	Label     string
	SortOrder int
}

// ListGroups returns every group in display order.
func ListGroups(ctx context.Context, q Queryer) ([]Group, error) {
	rows, err := q.Query(ctx,
		`SELECT key, label, sort_order FROM platform_tool_groups ORDER BY sort_order, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil so an empty table marshals as [] rather than null.
	groups := []Group{}
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.Key, &g.Label, &g.SortOrder); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

// ListTools returns every tool, ordered by its group's position and then its
// own — the order the page renders in, decided here rather than in the
// renderer so both consumers get the same one.
func ListTools(ctx context.Context, q Queryer) ([]Tool, error) {
	rows, err := q.Query(ctx,
		`SELECT t.id, t.name, t.subdomain, t.purpose, t.note, t.group_key, t.sort_order
		   FROM platform_tools t
		   JOIN platform_tool_groups g ON g.key = t.group_key
		  ORDER BY g.sort_order, t.sort_order, t.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tools := []Tool{}
	for rows.Next() {
		var t Tool
		if err := rows.Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note,
			&t.GroupKey, &t.SortOrder); err != nil {
			return nil, err
		}
		tools = append(tools, t)
	}
	return tools, rows.Err()
}
```

- [ ] **Step 5: Run the tests and confirm zero skips**

```bash
cd platform-api && go test ./internal/modules/tools/... -v 2>&1 | tail -30
```

Expected: all six tests PASS, and no line contains `SKIP`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/db/migrations/0031_platform_tools.sql \
        platform-api/internal/modules/tools/internal/repository/
git commit -m "feat(platform-api): seed the internal tools directory into tesserix_admin"
```

---

## Task 2: The domain — validation, with no SQL and no HTTP

**Files:**
- Create: `platform-api/internal/modules/tools/internal/domain/tool.go`
- Test: `platform-api/internal/modules/tools/internal/domain/tool_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `domain.Tool{Name, Subdomain, Purpose, Note *string, GroupKey string, SortOrder *int}`,
  `(domain.Tool) Normalise() domain.Tool`, `(domain.Tool) Validate() error`,
  `domain.Group{Key, Label string, SortOrder *int}` with the same two methods,
  `domain.SubdomainPattern`.

- [ ] **Step 1: Write the failing test**

Create `platform-api/internal/modules/tools/internal/domain/tool_test.go`:

```go
package domain_test

import (
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/domain"
)

func ptr[T any](v T) *T { return &v }

func TestNormaliseTrimsAndCollapsesAnEmptyNoteToAbsence(t *testing.T) {
	got := domain.Tool{
		Name:      "  Grafana  ",
		Subdomain: "  GRAFANA  ",
		Purpose:   "  Dashboards.  ",
		Note:      ptr("   "),
		GroupKey:  "  observability ",
	}.Normalise()

	if got.Name != "Grafana" {
		t.Errorf("name = %q, want trimmed", got.Name)
	}
	// Lower-cased rather than refused: a capitalised subdomain is a typo with
	// one obvious reading, and the DNS label it becomes is unambiguous.
	if got.Subdomain != "grafana" {
		t.Errorf("subdomain = %q, want lower-cased and trimmed", got.Subdomain)
	}
	if got.Purpose != "Dashboards." {
		t.Errorf("purpose = %q, want trimmed", got.Purpose)
	}
	// A note of spaces is not a note. Collapsed BEFORE validation so it is
	// never refused for a length it does not have.
	if got.Note != nil {
		t.Errorf("note = %q, want nil for whitespace", *got.Note)
	}
	if got.GroupKey != "observability" {
		t.Errorf("group_key = %q, want trimmed", got.GroupKey)
	}
}

func TestValidateRefusesASubdomainThatIsNotADnsLabel(t *testing.T) {
	for _, bad := range []string{
		"https://grafana.tesserix.app",
		"grafana.tesserix.app",
		"-leading",
		"trailing-",
		"under_score",
		"",
		strings.Repeat("a", 64),
	} {
		err := domain.Tool{Name: "x", Subdomain: bad, Purpose: "x", GroupKey: "reference"}.Validate()
		if err == nil {
			t.Errorf("subdomain %q was accepted; the API must refuse what the CHECK refuses", bad)
		}
	}
}

func TestValidateAcceptsTheSubdomainsAlreadyInUse(t *testing.T) {
	for _, good := range []string{"auth", "secret-service", "costestimator", "ui", "analytics"} {
		if err := domain.Tool{Name: "x", Subdomain: good, Purpose: "x", GroupKey: "reference"}.Validate(); err != nil {
			t.Errorf("subdomain %q was refused but is in the seed: %v", good, err)
		}
	}
}

func TestValidateRequiresNameAndPurposeAndGroup(t *testing.T) {
	cases := map[string]domain.Tool{
		"no name":    {Subdomain: "x", Purpose: "x", GroupKey: "reference"},
		"no purpose": {Name: "x", Subdomain: "x", GroupKey: "reference"},
		"no group":   {Name: "x", Subdomain: "x", Purpose: "x"},
	}
	for name, tool := range cases {
		if err := tool.Validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestValidateRefusesAnOverlongField(t *testing.T) {
	long := strings.Repeat("a", 201)
	if err := (domain.Tool{Name: "x", Subdomain: "x", Purpose: long, GroupKey: "reference"}).Validate(); err == nil {
		t.Error("a 201-character purpose was accepted; the card cannot render it")
	}
	if err := (domain.Tool{Name: "x", Subdomain: "x", Purpose: "x", GroupKey: "reference",
		Note: ptr(long)}).Validate(); err == nil {
		t.Error("a 201-character note was accepted")
	}
}

func TestValidateRefusesANegativeSortOrder(t *testing.T) {
	if err := (domain.Tool{Name: "x", Subdomain: "x", Purpose: "x", GroupKey: "reference",
		SortOrder: ptr(-1)}).Validate(); err == nil {
		t.Error("a negative sort_order was accepted")
	}
}

func TestAGroupValidatesItsKeyAsAnIdentifier(t *testing.T) {
	if err := (domain.Group{Key: "Not A Key", Label: "x"}).Validate(); err == nil {
		t.Error("a group key with spaces was accepted; it is referenced by tools")
	}
	if err := (domain.Group{Key: "observability", Label: ""}).Validate(); err == nil {
		t.Error("a group with no label was accepted; it renders as a blank heading")
	}
	if err := (domain.Group{Key: "observability", Label: "Observability"}).Validate(); err != nil {
		t.Errorf("a legitimate group was refused: %v", err)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd platform-api && go test ./internal/modules/tools/internal/domain/... -v
```

Expected: build failure, `domain` package does not exist. These tests need no
database, so they must NOT skip — a skip here means the wrong package ran.

- [ ] **Step 3: Write the domain**

Create `platform-api/internal/modules/tools/internal/domain/tool.go`:

```go
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
```

- [ ] **Step 4: Run the tests**

```bash
cd platform-api && go test ./internal/modules/tools/internal/domain/... -v
```

Expected: all seven PASS.

- [ ] **Step 5: Prove the two subdomain rules agree**

Add to `platform-api/internal/modules/tools/internal/repository/tools_test.go`:

```go
func TestTheApiAndTheDatabaseRefuseTheSameSubdomains(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	// The regex is written twice — once in domain, once in migration 0031 —
	// and this is what keeps the copies honest. A divergence means either a
	// 500 from a constraint the API thought it had already checked, or a row
	// the API refuses that the database would have taken.
	for _, candidate := range []string{
		"auth", "secret-service", "costestimator",
		"https://grafana.tesserix.app", "grafana.tesserix.app",
		"Grafana", "-leading", "trailing-", "under_score", "",
	} {
		apiOK := domain.Tool{Name: "x", Subdomain: candidate, Purpose: "x",
			GroupKey: "reference"}.Normalise().Validate() == nil

		_, err := pool.Exec(ctx,
			`INSERT INTO platform_tools (name, subdomain, purpose, group_key, sort_order)
			 VALUES ('probe', $1, 'probe', 'reference', 999)`, candidate)
		dbOK := err == nil
		if dbOK {
			_, _ = pool.Exec(ctx, `DELETE FROM platform_tools WHERE subdomain = $1 AND name = 'probe'`, candidate)
		}

		// "Grafana" is the one legitimate asymmetry: the API lower-cases it in
		// Normalise, so it accepts what the raw database refuses.
		if candidate == "Grafana" {
			continue
		}
		if apiOK != dbOK {
			t.Errorf("subdomain %q: API accepts=%v, database accepts=%v — the CHECK in "+
				"0031 and domain.SubdomainPattern have drifted", candidate, apiOK, dbOK)
		}
	}
}
```

Add the `domain` import to that file. Run:

```bash
cd platform-api && go test ./internal/modules/tools/... -v 2>&1 | tail -20
```

Expected: PASS, zero skips.

- [ ] **Step 6: Commit**

```bash
git add platform-api/internal/modules/tools/internal/domain/ \
        platform-api/internal/modules/tools/internal/repository/tools_test.go
git commit -m "feat(platform-api): validate a tool directory entry before it is stored"
```

---

## Task 3: The read routes, wired end to end

**Files:**
- Create: `platform-api/internal/modules/tools/tools.go`
- Create: `platform-api/internal/modules/tools/internal/service/service.go`
- Create: `platform-api/internal/modules/tools/internal/service/wire.go`
- Create: `platform-api/internal/modules/tools/internal/handler/handler.go`
- Create: `platform-api/internal/modules/tools/internal/handler/handler_test.go`
- Create: `platform-api/internal/modules/tools/internal/handler/capability_test.go`
- Modify: `platform-api/cmd/server/main.go:117`

**Interfaces:**
- Consumes: `repository.ListTools`, `repository.ListGroups` (Task 1).
- Produces: `tools.Register(mux, tools.Config{Pool, Verifier, Log})`,
  `handler.RouteTable []handler.Route`, `handler.Route{Method, Pattern, Write}`,
  `service.Service` with `Tools(ctx) (ToolsPayload, error)` and
  `Groups(ctx) (GroupsPayload, error)`, wire types `service.ToolWire` and
  `service.GroupWire`.

- [ ] **Step 1: Write the failing handler test**

Create `platform-api/internal/modules/tools/internal/handler/handler_test.go`:

```go
package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The module is exercised through its REAL router, its real verifier and a
// real database. Only the token's signature is faked.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Email:     "operator@tesserix.test",
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

// processTimeZone is forced onto the test process, and deliberately not UTC.
//
// pgx decodes a timestamptz into time.Local, so time.Local — not the database
// session's zone — is what decides whether a rendered timestamp carries Z or
// an offset. Without this the suite is green in a UTC container and red on a
// laptop in +10:00, which is to say green in CI with the normalisation
// removed. The CRM module paid for this once already.
const processTimeZone = "Australia/Sydney"

func TestMain(m *testing.M) {
	zone, err := time.LoadLocation(processTimeZone)
	if err != nil {
		fmt.Fprintf(os.Stderr, "loading %s: %v\n", processTimeZone, err)
		os.Exit(1)
	}
	time.Local = zone
	now := time.Now()
	if now.Format(time.RFC3339) == now.UTC().Format(time.RFC3339) {
		fmt.Fprintf(os.Stderr, "the test process is still rendering UTC; the guard proves nothing\n")
		os.Exit(1)
	}
	os.Exit(m.Run())
}

type api struct {
	handler http.Handler
	pool    *pgxpool.Pool
	t       *testing.T
}

func serve(t *testing.T) *api { t.Helper(); return serveAs(t, "read", "platform") }

func serveAs(t *testing.T, roles ...string) *api {
	t.Helper()
	pool := testdb.New(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives. This composes what
	// cmd/server composes, line for line.
	httpx.RegisterModule(mux, verifier, "tools", func(m *http.ServeMux) {
		tools.Register(m, tools.Config{Pool: pool, Verifier: verifier, Log: log})
	})

	return &api{handler: httpx.WithMiddleware(mux), pool: pool, t: t}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path, body string, headers map[string]string) response {
	a.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	// Every answer is enveloped, refusals included, so a body that will not
	// parse is a finding rather than an inconvenience.
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path, "", nil) }

// data returns the response's `data` object, failing if the call did not
// succeed.
func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("not a success: %s", r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", r.raw)
	}
	return data
}

func TestTheToolsListIsTheSeededDirectory(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/platform/tools").data(t)

	// A NAMED payload object, never a bare array — §1. A client that has to
	// branch on whether `data` is an array or an object has been given two
	// contracts.
	list, ok := got["tools"].([]any)
	if !ok {
		t.Fatalf(`data.tools is not an array: %v`, got)
	}
	if len(list) != 15 {
		t.Fatalf("got %d tools, want 15", len(list))
	}

	first, _ := list[0].(map[string]any)
	if first["subdomain"] != "auth" {
		t.Errorf("first tool subdomain = %v, want auth — identity is the first group", first["subdomain"])
	}
	// snake_case on the wire, and the absent note is null rather than missing:
	// a client reading `note` should not have to distinguish the two.
	if _, ok := first["group_key"]; !ok {
		t.Error("group_key is missing; the wire is snake_case")
	}
	if note, present := first["note"]; !present || note != nil {
		t.Errorf("Zitadel's note = %v, want an explicit null", note)
	}
}

func TestTheGroupsListIsInDisplayOrder(t *testing.T) {
	a := serve(t)

	got := a.get("/v1/platform/tool-groups").data(t)

	list, ok := got["groups"].([]any)
	if !ok {
		t.Fatalf("data.groups is not an array: %v", got)
	}
	want := []string{"identity", "observability", "delivery", "cost", "reference"}
	if len(list) != len(want) {
		t.Fatalf("got %d groups, want %d", len(list), len(want))
	}
	for i, key := range want {
		g, _ := list[i].(map[string]any)
		if g["key"] != key {
			t.Errorf("group %d = %v, want %s", i, g["key"], key)
		}
	}
}

func TestAnUnknownQueryParameterIsRefused(t *testing.T) {
	a := serve(t)

	// The read-side twin of DisallowUnknownFields. A caller sending ?groups=x
	// is told, rather than answered with the whole directory reported as a
	// success.
	got := a.get("/v1/platform/tools?group=identity")

	if got.status != http.StatusBadRequest {
		t.Errorf("an unknown parameter = %d, want 400: %s", got.status, got.raw)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd platform-api && go test ./internal/modules/tools/internal/handler/... -v
```

Expected: build failure — no `tools` package. Not a skip.

- [ ] **Step 3: Write the wire types**

Create `platform-api/internal/modules/tools/internal/service/wire.go`:

```go
package service

import "github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/repository"

// The wire shapes. snake_case, named payload objects, `[]` never null.
//
// Separate from repository.Tool so a column rename is not a contract change:
// the console's parser is written against THESE names, and they are in the
// golden files.

// ToolWire is one directory entry as a client sees it.
type ToolWire struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Subdomain string  `json:"subdomain"`
	Purpose   string  `json:"purpose"`
	// A pointer so absence is an explicit null rather than a missing key. A
	// client reading `note` should not have to distinguish the two.
	Note      *string `json:"note"`
	GroupKey  string  `json:"group_key"`
	SortOrder int     `json:"sort_order"`
}

// GroupWire is one heading as a client sees it.
type GroupWire struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	SortOrder int    `json:"sort_order"`
}

// ToolsPayload is the tools listing's `data`.
type ToolsPayload struct {
	Tools []ToolWire `json:"tools"`
}

// ToolPayload is one tool's `data`, which every write answers with.
type ToolPayload struct {
	Tool ToolWire `json:"tool"`
}

// GroupsPayload is the groups listing's `data`.
type GroupsPayload struct {
	Groups []GroupWire `json:"groups"`
}

// GroupPayload is one group's `data`.
type GroupPayload struct {
	Group GroupWire `json:"group"`
}

func toolWire(t repository.Tool) ToolWire {
	return ToolWire{
		ID: t.ID, Name: t.Name, Subdomain: t.Subdomain, Purpose: t.Purpose,
		Note: t.Note, GroupKey: t.GroupKey, SortOrder: t.SortOrder,
	}
}

func toolWires(rows []repository.Tool) []ToolWire {
	// Non-nil so an empty directory marshals as [] rather than null.
	out := make([]ToolWire, 0, len(rows))
	for _, row := range rows {
		out = append(out, toolWire(row))
	}
	return out
}

func groupWire(g repository.Group) GroupWire {
	return GroupWire{Key: g.Key, Label: g.Label, SortOrder: g.SortOrder}
}

func groupWires(rows []repository.Group) []GroupWire {
	out := make([]GroupWire, 0, len(rows))
	for _, row := range rows {
		out = append(out, groupWire(row))
	}
	return out
}
```

- [ ] **Step 4: Write the service's read path**

Create `platform-api/internal/modules/tools/internal/service/service.go`:

```go
// Package service is the tools module's operations over a pool.
package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/repository"
)

// Service is the module's operations. Thin: the reads are one query and one
// mapping, and the writes are transaction scripts that need somewhere to live
// that is not an HTTP handler.
type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ErrRefused means the request was understood and the domain declined it —
// 422, distinct from a malformed request (400) and a missing row (404).
var ErrRefused = errors.New("the request was refused")

// ErrNotFound means the tool or group does not exist.
var ErrNotFound = errors.New("not found")

// ErrConflict means the row cannot be written as asked without displacing
// something else — a duplicate subdomain, or a group that still has tools.
var ErrConflict = errors.New("conflict")

// Tools reads the whole directory.
//
// Unpaginated, deliberately. See the handler's package comment.
func (s *Service) Tools(ctx context.Context) (ToolsPayload, error) {
	rows, err := repository.ListTools(ctx, s.pool)
	if err != nil {
		return ToolsPayload{}, err
	}
	return ToolsPayload{Tools: toolWires(rows)}, nil
}

// Groups reads every heading, in display order.
func (s *Service) Groups(ctx context.Context) (GroupsPayload, error) {
	rows, err := repository.ListGroups(ctx, s.pool)
	if err != nil {
		return GroupsPayload{}, err
	}
	return GroupsPayload{Groups: groupWires(rows)}, nil
}
```

- [ ] **Step 5: Write the handler with its route table**

Create `platform-api/internal/modules/tools/internal/handler/handler.go`:

```go
// Package handler is the tools module's HTTP surface: the routes, the
// capability gate, and the mapping from a failure to a status code.
//
// # The surface, in full
//
//	GET    /v1/platform/tools              the whole directory
//	POST   /v1/platform/tools              add an entry
//	PATCH  /v1/platform/tools/{id}         change one
//	DELETE /v1/platform/tools/{id}         remove one
//	GET    /v1/platform/tool-groups        the headings, in display order
//	POST   /v1/platform/tool-groups        add one
//	PATCH  /v1/platform/tool-groups/{key}  change one
//	DELETE /v1/platform/tool-groups/{key}  remove one
//
// # There is no pagination, and that is a decision rather than an omission
//
// This is a fifteen-row directory that the console renders WHOLE — the home
// page shows every group and every tool at once, and the command palette
// searches across all of them. A keyset cursor over it would be ceremony that
// every caller immediately undid by paging to exhaustion. §4's pagination rule
// exists for queues that grow without bound; this list grows when somebody
// deploys a new internal tool, which is a handful of times a year.
//
// Recorded here because an unpaginated list that says nothing looks like one
// where pagination was forgotten, and the next reader would be right to
// wonder.
//
// # Every route gates on `platform`
//
// Taken from `platform.dashboard` in packages/console-core/src/routes.ts,
// which is the surface the directory is served on. There is no verb to stack:
// the vocabulary's verbs — respond, mass-send, hard-delete,
// rotate-credentials, adjust-balance, execute-refund — none of them names
// editing a directory of links. Inventing `tools-write` would assert a Zitadel
// role nobody holds, which fails closed on every real operator.
package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths. Write says which gate it goes behind and
// tells a test which routes carry a body.
type Route struct {
	Method  string
	Pattern string
	Write   bool
	// handler is unexported so the table stays a description of the surface
	// rather than a handle on it.
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared.
//
// Registration reads this table, so a route not in it is not served; and
// capability_test ranges over it and FAILS on an entry it has no case for, so
// a route added here without a capability case turns the suite red rather than
// passing untested.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/platform/tools",
		handler: func(h *Handler) http.HandlerFunc { return h.listTools }},
	{Method: http.MethodPost, Pattern: "/v1/platform/tools", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.createTool }},
	{Method: http.MethodPatch, Pattern: "/v1/platform/tools/{id}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.updateTool }},
	{Method: http.MethodDelete, Pattern: "/v1/platform/tools/{id}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.deleteTool }},
	{Method: http.MethodGet, Pattern: "/v1/platform/tool-groups",
		handler: func(h *Handler) http.HandlerFunc { return h.listGroups }},
	{Method: http.MethodPost, Pattern: "/v1/platform/tool-groups", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.createGroup }},
	{Method: http.MethodPatch, Pattern: "/v1/platform/tool-groups/{key}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.updateGroup }},
	{Method: http.MethodDelete, Pattern: "/v1/platform/tool-groups/{key}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.deleteGroup }},
}

// Routes mounts the table. Named Routes rather than Register because the
// module's public Register/Config file is tools.go, and it calls this.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	gate := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapPlatform, h.log, handler))
	}
	for _, route := range RouteTable {
		mux.Handle(route.Method+" "+route.Pattern, gate(route.handler(h)))
	}
}

// Neither read takes a parameter, so the allowed set is empty and ANY query
// string is refused. That is stricter than it looks and it is right: there is
// no filtering to ask for, so `?group=identity` is a caller expecting
// behaviour this endpoint does not have.
var noParameters = []string{}

func (h *Handler) listTools(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.Tools(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) listGroups(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.Groups(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

// fail maps a failure to a status code.
//
// Four domain outcomes, four codes, because collapsing any pair would make two
// different problems indistinguishable to a client deciding whether to retry.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotFound):
		httpx.WriteError(w, r, httpx.NotFound(unwrap(err)), h.log)
	case errors.Is(err, service.ErrConflict):
		httpx.WriteError(w, r, httpx.Conflict(unwrap(err)), h.log)
	case errors.Is(err, service.ErrRefused), errors.Is(err, domain.ErrInvalid):
		httpx.WriteError(w, r, httpx.Validation(unwrap(err), nil), h.log)
	case errors.Is(err, idempotency.ErrInvalidKey):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	default:
		httpx.WriteError(w, r, err, h.log)
	}
}

// unwrap returns the message without the sentinel's prefix. The sentinel names
// the CLASS of failure, which the status code already carries; the message is
// the part a caller can act on.
func unwrap(err error) string {
	message := err.Error()
	for _, prefix := range []string{
		service.ErrRefused.Error() + ": ",
		service.ErrNotFound.Error() + ": ",
		service.ErrConflict.Error() + ": ",
		domain.ErrInvalid.Error() + ": ",
	} {
		if len(message) > len(prefix) && message[:len(prefix)] == prefix {
			return message[len(prefix):]
		}
	}
	return message
}
```

**Note for the implementer:** the write handlers (`createTool`, `updateTool`,
`deleteTool`, `createGroup`, `updateGroup`, `deleteGroup`) are Task 4. To keep
this task compiling and its tests meaningful, add them now as stubs that answer
501 and are replaced wholesale in Task 4:

```go
// Replaced in Task 4. A stub rather than an absent route because RouteTable is
// what registration reads, and a table that does not yet list the writes would
// make Task 4 a change to the surface rather than a filling-in of it.
func (h *Handler) createTool(w http.ResponseWriter, r *http.Request)  { h.notYet(w, r) }
func (h *Handler) updateTool(w http.ResponseWriter, r *http.Request)  { h.notYet(w, r) }
func (h *Handler) deleteTool(w http.ResponseWriter, r *http.Request)  { h.notYet(w, r) }
func (h *Handler) createGroup(w http.ResponseWriter, r *http.Request) { h.notYet(w, r) }
func (h *Handler) updateGroup(w http.ResponseWriter, r *http.Request) { h.notYet(w, r) }
func (h *Handler) deleteGroup(w http.ResponseWriter, r *http.Request) { h.notYet(w, r) }

func (h *Handler) notYet(w http.ResponseWriter, r *http.Request) {
	httpx.WriteError(w, r, httpx.Error{StatusCode: http.StatusNotImplemented,
		Code: "NOT_IMPLEMENTED", Message: "this write is not built yet"}, h.log)
}
```

The field names are `Code`, `Message`, `StatusCode` and `Details`
(`internal/platform/httpx/errors.go:67`) — `StatusCode`, not `Status`, and it
never reaches the wire. The `Code` constants are SCREAMING_SNAKE (`CodeNotFound
= "NOT_FOUND"`); `NOT_IMPLEMENTED` has no constant because nothing else answers
501, and these stubs are deleted in Tasks 4–5.


**These four write helpers are NOT in this task.** `maxBodyBytes`, `beginWrite`,
`readKey` and `decode` are used only by the write handlers, so declaring them
here leaves four unused symbols — and `golangci-lint`'s `unused` check fails on
exactly that, which means this task's commit would not pass CI on its own.
Task 4 introduces them alongside the handlers that call them. (An earlier draft
of this plan put them here; the Task 3 implementer's commit tripped the linter
and it was moved.)

- [ ] **Step 6: Write the module's public surface**

Create `platform-api/internal/modules/tools/tools.go`:

```go
// Package tools is the platform API's internal-tools-directory module.
//
// # The module's public surface is this file, and nothing else
//
// Register and Config. Everything it does lives under internal/, which the
// compiler permits only code rooted here to import.
//
// # What this module is, in one line
//
// The directory of internal tools behind *.tesserix.app — Zitadel, Grafana,
// ArgoCD and a dozen more — which the console home page and command palette
// both render. It was a literal in packages/console-core/src/tools.ts until
// #318; the tables are seeded from that literal by migration 0031.
//
// # What it deliberately does NOT carry
//
// Status. Whether a tool is UP belongs to the health strip, and several of
// these expose no status endpoint at all — a status column here would be
// honest for some rows and a lie for the rest. The rule predates the move and
// survives it; see the head of tools.ts.
//
// # It imports no other module
//
// Only the kernel — httpx, auth, audit, idempotency, write — and its own
// internals.
package tools

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Config is what the module needs from the composition root.
type Config struct {
	// Pool is the shared tesserix-postgres pool. The module does not open its
	// own — no module does.
	Pool *pgxpool.Pool
	// Verifier authenticates both principal types. Never nil:
	// httpx.RegisterModule refuses to register a module without one.
	Verifier *auth.Verifier
	Log      *slog.Logger
}

// Register mounts the module's routes.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Pool), cfg.Log).Routes(mux, cfg.Verifier)
}
```

- [ ] **Step 7: Write the capability test**

Create `platform-api/internal/modules/tools/internal/handler/capability_test.go`:

```go
package handler_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/handler"
)

// The pair §9 requires, and the enumeration that keeps them honest.
//
// Neither test is worth anything alone: a refusal test on its own is satisfied
// by a route that does not exist, because a 403 from a mistyped path looks
// exactly like a 403 from the capability gate. The companion sends the SAME
// requests with the capability present and insists they work.

type routeCase struct {
	// body is empty for a read.
	body string
	// want is the status the same request produces once the capability is
	// there. Named per route rather than assumed to be 200, so a 201 does not
	// have to weaken the assertion to "anything but 403" — which would let a
	// 500 pass for a success.
	want int
}

// routeCases is one entry per route in handler.RouteTable, keyed by
// "METHOD /pattern" exactly as the table spells it.
//
// This map is the fail-closed half: both tests range over RouteTable and FAIL
// on an entry with no case here, so a ninth route cannot be served untested.
func routeCases() map[string]routeCase {
	return map[string]routeCase{
		"GET /v1/platform/tools":       {want: http.StatusOK},
		"GET /v1/platform/tool-groups": {want: http.StatusOK},
		// The writes answer 501 until Task 4. The point of the case is the
		// REFUSAL half — a stub must be behind the gate too — and `want` is
		// updated to 201/200/200 when the writes land.
		"POST /v1/platform/tools": {
			body: `{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`,
			want: http.StatusNotImplemented,
		},
		"PATCH /v1/platform/tools/{id}": {
			body: `{"purpose":"Changed."}`,
			want: http.StatusNotImplemented,
		},
		"DELETE /v1/platform/tools/{id}": {want: http.StatusNotImplemented},
		"POST /v1/platform/tool-groups": {
			body: `{"key":"security","label":"Security"}`,
			want: http.StatusNotImplemented,
		},
		"PATCH /v1/platform/tool-groups/{key}": {
			body: `{"label":"Changed"}`,
			want: http.StatusNotImplemented,
		},
		"DELETE /v1/platform/tool-groups/{key}": {want: http.StatusNotImplemented},
	}
}

func caseFor(t *testing.T, route handler.Route) routeCase {
	t.Helper()
	key := route.Method + " " + route.Pattern
	c, ok := routeCases()[key]
	if !ok {
		t.Fatalf("%s is registered but has no capability case; add it to routeCases so "+
			"the route is proved to refuse a principal without `platform` AND to answer "+
			"one that holds it", key)
	}
	return c
}

// path fills a pattern in with real identifiers from the seed, not
// plausible-looking strings: a 404 from a nonexistent row would mask the very
// difference the companion test exists to show.
func path(t *testing.T, a *api, pattern string) string {
	t.Helper()
	filled := strings.ReplaceAll(pattern, "{key}", "reference")
	if strings.Contains(filled, "{id}") {
		var id string
		if err := a.pool.QueryRow(t.Context(),
			`SELECT id FROM platform_tools WHERE subdomain = 'docs'`).Scan(&id); err != nil {
			t.Fatalf("finding a seeded tool: %v", err)
		}
		filled = strings.ReplaceAll(filled, "{id}", id)
	}
	return filled
}

func TestEveryRouteRefusesAPrincipalWithoutThePlatformCapability(t *testing.T) {
	// A token that is entirely valid — right issuer, right audience, not
	// expired — and holds `read`, which is console entry and nothing else.
	// This is the exact shape of the threat: a real session.
	a := serveAs(t, "read")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
		if got.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 — a valid session is not authorisation: %s",
				route.Method, route.Pattern, got.status, got.raw)
		}
	}
}

// The companion. Same routes, same bodies, same fixture — with `platform`.
func TestTheSameRequestsWithTheCapabilitySucceed(t *testing.T) {
	a := serveAs(t, "read", "platform")

	for _, route := range handler.RouteTable {
		c := caseFor(t, route)
		got := a.do(route.Method, path(t, a, route.Pattern), c.body, nil)
		if got.status != c.want {
			t.Errorf("%s %s with `platform` = %d, want %d — the refusal above proves "+
				"nothing unless this request works: %s",
				route.Method, route.Pattern, got.status, c.want, got.raw)
		}
	}
}

func TestAnUnauthenticatedRequestIs401AndNot403(t *testing.T) {
	// Different questions with different answers: "who are you" and "may you".
	// A caller told 403 would go looking for a missing role when the problem is
	// a missing token.
	a := serve(t)

	req := httptest.NewRequest(http.MethodGet, "/v1/platform/tools", nil)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
}
```

If `t.Context()` is unavailable on the repo's Go version, use
`context.Background()` and add the import.

- [ ] **Step 8: Run the handler tests**

```bash
cd platform-api && go test ./internal/modules/tools/... -v 2>&1 | tail -40
```

Expected: all PASS, zero SKIP.

- [ ] **Step 9: Register the module in the composition root**

In `platform-api/cmd/server/main.go`, after the `aiusage` registration at
line 117, add:

```go
	httpx.RegisterModule(mux, verifier, "tools", func(m *http.ServeMux) {
		tools.Register(m, tools.Config{Pool: pool.Pool, Verifier: verifier, Log: log})
	})
```

and add the import
`"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools"`.

- [ ] **Step 10: Prove the architecture check and the whole suite still pass**

```bash
cd platform-api && go build ./... && go vet ./... && go test ./... 2>&1 | tail -20
```

Expected: `internal/architecture` passes (the module imports no sibling), and
no package fails.

- [ ] **Step 11: Commit**

```bash
git add platform-api/internal/modules/tools/ platform-api/cmd/server/main.go
git commit -m "feat(platform-api): serve the internal tools directory at /v1/platform/tools"
```

---

## Task 4: The tool writes

**Files:**
- Modify: `platform-api/internal/modules/tools/internal/repository/tools.go`
- Modify: `platform-api/internal/modules/tools/internal/service/service.go`
- Modify: `platform-api/internal/modules/tools/internal/handler/handler.go`
- Modify: `platform-api/internal/modules/tools/internal/handler/capability_test.go`
- Test: `platform-api/internal/modules/tools/internal/handler/handler_test.go`

**Interfaces:**
- Consumes: `domain.Tool` (Task 2), `service.ErrRefused/ErrNotFound/ErrConflict`,
  `write.Perform`, `audit.Entry`, `idempotency.Key` (Task 3).
- Produces: `service.CreateTool(ctx, Actor, domain.Tool, *idempotency.Key) (write.Result, error)`,
  `service.UpdateTool(ctx, Actor, id string, patch ToolPatch, *idempotency.Key) (write.Result, error)`,
  `service.DeleteTool(ctx, Actor, id string, *idempotency.Key) (write.Result, error)`,
  `service.Actor{Subject, Email string}`, `service.ToolPatch`.

- [ ] **Step 1: Write the failing write tests**

Append to `platform-api/internal/modules/tools/internal/handler/handler_test.go`:

```go
func (a *api) toolID(subdomain string) string {
	a.t.Helper()
	var id string
	if err := a.pool.QueryRow(context.Background(),
		`SELECT id FROM platform_tools WHERE subdomain = $1`, subdomain).Scan(&id); err != nil {
		a.t.Fatalf("finding %s: %v", subdomain, err)
	}
	return id
}

func TestCreatingAToolAnswers201WithTheRow(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Distributed traces.","group_key":"observability"}`, nil)

	if got.status != http.StatusCreated {
		t.Fatalf("create = %d, want 201: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["subdomain"] != "tempo" {
		t.Errorf("created tool = %v, want subdomain tempo", tool)
	}
	if tool["id"] == nil || tool["id"] == "" {
		t.Error("the created tool has no id; a client cannot address it to edit it")
	}
	// Absent sort_order means "last in its group" rather than 0, which would
	// silently make a new tool the first one.
	if order, ok := tool["sort_order"].(float64); !ok || order <= 1 {
		t.Errorf("sort_order = %v, want the end of the observability group", tool["sort_order"])
	}
}

func TestCreatingAToolWithAUrlForASubdomainIs422(t *testing.T) {
	a := serve(t)

	// The property the whole schema exists to protect: a row that carries a
	// host would send a dev console's operators to production.
	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Grafana","subdomain":"https://grafana.tesserix.app","purpose":"x","group_key":"observability"}`, nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("a URL as a subdomain = %d, want 422: %s", got.status, got.raw)
	}
}

func TestCreatingAToolInAnUnknownGroupIs422AndNot500(t *testing.T) {
	a := serve(t)

	// The foreign key would refuse this anyway; the point is that the caller
	// is told which field is wrong rather than handed a constraint name.
	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"x","subdomain":"x","purpose":"x","group_key":"no-such-group"}`, nil)

	if got.status != http.StatusUnprocessableEntity {
		t.Errorf("an unknown group = %d, want 422: %s", got.status, got.raw)
	}
}

func TestCreatingADuplicateSubdomainIs409(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Another","subdomain":"auth","purpose":"x","group_key":"identity"}`, nil)

	// 409 rather than 422: the request is entirely valid, and what refuses it
	// is the state of the directory rather than the shape of the input.
	if got.status != http.StatusConflict {
		t.Errorf("a duplicate subdomain = %d, want 409: %s", got.status, got.raw)
	}
}

func TestAnUnknownFieldInTheBodyIsRefused(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"x","subdomain":"x","purpose":"x","group_key":"reference","status":"up"}`, nil)

	// `status` is the exact field this directory refuses to carry, and a
	// silent 201 that dropped it would be the worst possible answer.
	if got.status != http.StatusBadRequest {
		t.Errorf("an unknown field = %d, want 400: %s", got.status, got.raw)
	}
}

func TestPatchingChangesOnlyWhatWasSent(t *testing.T) {
	a := serve(t)
	id := a.toolID("kibana")

	got := a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"purpose":"Log search."}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["purpose"] != "Log search." {
		t.Errorf("purpose = %v, want the new value", tool["purpose"])
	}
	if tool["name"] != "Kibana" {
		t.Errorf("name = %v, want it untouched — PATCH changes what was sent", tool["name"])
	}
	if tool["group_key"] != "observability" {
		t.Errorf("group_key = %v, want it untouched", tool["group_key"])
	}
}

func TestPatchingCanClearANote(t *testing.T) {
	a := serve(t)
	id := a.toolID("argocd")

	got := a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"note":null}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	// An explicit null clears; an ABSENT key leaves it alone. Both spellings
	// have to be expressible or a note could never be removed.
	if tool["note"] != nil {
		t.Errorf("note = %v, want null after an explicit null", tool["note"])
	}
}

func TestPatchingAnUnknownToolIs404(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPatch,
		"/v1/platform/tools/00000000-0000-0000-0000-000000000000", `{"name":"x"}`, nil)

	if got.status != http.StatusNotFound {
		t.Errorf("patching a missing tool = %d, want 404: %s", got.status, got.raw)
	}
}

func TestDeletingAToolRemovesItAndAnswersWithIt(t *testing.T) {
	a := serve(t)
	id := a.toolID("docs")

	got := a.do(http.MethodDelete, "/v1/platform/tools/"+id, "", nil)

	if got.status != http.StatusOK {
		t.Fatalf("delete = %d, want 200: %s", got.status, got.raw)
	}
	tool, _ := got.data(t)["tool"].(map[string]any)
	if tool["subdomain"] != "docs" {
		t.Errorf("delete answered with %v, want the row as it was", tool)
	}
	if after := a.get("/v1/platform/tools").data(t)["tools"].([]any); len(after) != 14 {
		t.Errorf("after deleting one of 15 there are %d", len(after))
	}
}

func TestARepeatedWriteUnderOneIdempotencyKeyHappensOnce(t *testing.T) {
	a := serve(t)
	body := `{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`
	headers := map[string]string{"Idempotency-Key": "6f1c0f4e-2b7a-4a1f-9d3e-0c5b8a2e7d11"}

	first := a.do(http.MethodPost, "/v1/platform/tools", body, headers)
	second := a.do(http.MethodPost, "/v1/platform/tools", body, headers)

	if first.status != http.StatusCreated {
		t.Fatalf("first create = %d, want 201: %s", first.status, first.raw)
	}
	// The replay is the SAME answer, not a 409 from the unique constraint —
	// which is what a retry would get without the idempotency record.
	if second.status != first.status {
		t.Errorf("replay = %d, want the stored %d: %s", second.status, first.status, second.raw)
	}
	if got := len(a.get("/v1/platform/tools").data(t)["tools"].([]any)); got != 16 {
		t.Errorf("after one create and one replay there are %d tools, want 16", got)
	}
}

func TestAWriteRecordsAnAuditRow(t *testing.T) {
	a := serve(t)

	a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`, nil)

	var action, actor string
	err := a.pool.QueryRow(context.Background(),
		`SELECT action, actor FROM console_audit_log ORDER BY occurred_at DESC LIMIT 1`).
		Scan(&action, &actor)
	if err != nil {
		t.Fatalf("reading the audit trail: %v", err)
	}
	if action != "platform.tool.created" {
		t.Errorf("action = %q, want platform.tool.created", action)
	}
	if actor != subjectOperator {
		t.Errorf("actor = %q, want the principal's subject", actor)
	}
}
```

Confirm the audit table's name and columns against
`platform-api/internal/platform/audit/audit.go` before running; if it is not
`console_audit_log(action, actor, occurred_at)`, adjust the query rather than
the expectation.

- [ ] **Step 2: Run and watch them fail**

```bash
cd platform-api && go test ./internal/modules/tools/internal/handler/... -run 'Creating|Patching|Deleting|Repeated|AuditRow|UnknownField' -v
```

Expected: failures reporting 501 where 200/201/404/409/422 was wanted.

- [ ] **Step 3: Add the repository writes**

Append to `platform-api/internal/modules/tools/internal/repository/tools.go`:

```go
// Execer is a Queryer that also writes. The writes take a transaction, never a
// pool: they are performed inside write.Perform so the row, its audit entry
// and its idempotency record commit together or not at all.
type Execer interface {
	Queryer
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// ErrNoRow is returned when a write addressed a row that is not there.
// Distinguished here rather than at the call site because pgx.ErrNoRows means
// the same thing for a read that legitimately found nothing.
var ErrNoRow = errors.New("no such row")

// ErrDuplicateSubdomain is the unique constraint, named.
var ErrDuplicateSubdomain = errors.New("a tool with this subdomain already exists")

// ErrUnknownGroup is the foreign key, named.
var ErrUnknownGroup = errors.New("no group with this key exists")

// ErrGroupHasTools is ON DELETE RESTRICT, named.
var ErrGroupHasTools = errors.New("the group still has tools in it")

// classify turns a Postgres error into one of this package's sentinels.
//
// By CONSTRAINT NAME rather than by SQLSTATE alone: 23505 and 23503 each cover
// more than one constraint on these tables, and a caller told "already exists"
// for the wrong one would go and change the wrong field.
func classify(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch {
	case pgErr.Code == "23505" && strings.Contains(pgErr.ConstraintName, "subdomain"):
		return ErrDuplicateSubdomain
	case pgErr.Code == "23503" && strings.Contains(pgErr.ConstraintName, "group_key"):
		return ErrUnknownGroup
	case pgErr.Code == "23503":
		return ErrGroupHasTools
	case pgErr.Code == "23514" && strings.Contains(pgErr.ConstraintName, "dns_label"):
		// Reachable only if domain.SubdomainPattern and the CHECK have
		// drifted. Named anyway: a 500 carrying a constraint name is a worse
		// answer than a 422 saying what a subdomain must look like, even when
		// the API should have caught it first.
		return ErrInvalidSubdomain
	}
	return err
}

// ErrInvalidSubdomain is the CHECK constraint, named.
var ErrInvalidSubdomain = errors.New("a subdomain must be a single DNS label")

// NextSortOrder is the position a new entry takes in its group: the end.
//
// Computed rather than defaulted to zero, which would silently make every new
// tool the first one in its group.
func NextSortOrder(ctx context.Context, q Queryer, groupKey string) (int, error) {
	var next int
	err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platform_tools WHERE group_key = $1`,
		groupKey).Scan(&next)
	return next, err
}

// InsertTool adds an entry and returns it as stored.
func InsertTool(ctx context.Context, e Execer, name, subdomain, purpose string,
	note *string, groupKey string, sortOrder int,
) (Tool, error) {
	var t Tool
	err := e.QueryRow(ctx,
		`INSERT INTO platform_tools (name, subdomain, purpose, note, group_key, sort_order)
		      VALUES ($1, $2, $3, $4, $5, $6)
		   RETURNING id, name, subdomain, purpose, note, group_key, sort_order`,
		name, subdomain, purpose, note, groupKey, sortOrder).
		Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note, &t.GroupKey, &t.SortOrder)
	if err != nil {
		return Tool{}, classify(err)
	}
	return t, nil
}

// UpdateTool applies a partial change. A nil argument leaves the column alone;
// clearing the note is a non-nil pointer to a nil string, which is why
// clearNote is separate — SQL has no way to spell "set this to NULL" and
// "leave it" with one parameter.
func UpdateTool(ctx context.Context, e Execer, id string,
	name, subdomain, purpose, groupKey *string, note *string, clearNote bool, sortOrder *int,
) (Tool, error) {
	var t Tool
	err := e.QueryRow(ctx,
		`UPDATE platform_tools
		    SET name       = COALESCE($2, name),
		        subdomain  = COALESCE($3, subdomain),
		        purpose    = COALESCE($4, purpose),
		        group_key  = COALESCE($5, group_key),
		        note       = CASE WHEN $7 THEN NULL ELSE COALESCE($6, note) END,
		        sort_order = COALESCE($8, sort_order),
		        updated_at = now()
		  WHERE id = $1
		RETURNING id, name, subdomain, purpose, note, group_key, sort_order`,
		id, name, subdomain, purpose, groupKey, note, clearNote, sortOrder).
		Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note, &t.GroupKey, &t.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tool{}, ErrNoRow
	}
	if err != nil {
		return Tool{}, classify(err)
	}
	return t, nil
}

// DeleteTool removes an entry and returns it as it was, so the write can
// answer with what it removed.
func DeleteTool(ctx context.Context, e Execer, id string) (Tool, error) {
	var t Tool
	err := e.QueryRow(ctx,
		`DELETE FROM platform_tools WHERE id = $1
		 RETURNING id, name, subdomain, purpose, note, group_key, sort_order`, id).
		Scan(&t.ID, &t.Name, &t.Subdomain, &t.Purpose, &t.Note, &t.GroupKey, &t.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tool{}, ErrNoRow
	}
	if err != nil {
		return Tool{}, classify(err)
	}
	return t, nil
}
```

Add `errors`, `strings` and `github.com/jackc/pgx/v5/pgconn` to the imports.

**A UUID that is not a UUID:** `WHERE id = $1` with `id` a `text` parameter
against a `uuid` column makes Postgres raise 22P02 for a malformed id, which
`classify` passes through as a 500. Add to `classify`:

```go
	case pgErr.Code == "22P02":
		// A malformed uuid in the path. 404 is the honest answer: there is no
		// row with that identifier, and 500 would blame the service for the
		// caller's typo.
		return ErrNoRow
```

- [ ] **Step 4: Add the service writes**

Append to `platform-api/internal/modules/tools/internal/service/service.go`:

```go
// Actor is the principal performing a write, reduced to what an audit row
// needs.
type Actor struct {
	// Subject is the Zitadel `sub` — the audit trail's actor and the scope of
	// an idempotency key.
	Subject string
	// Email is what an operator recognises in the trail.
	Email string
}

// The audit trail's action names. Stable dotted identifiers, not prose: a
// retention or alerting rule discriminates on this column.
const (
	ActionToolCreated = "platform.tool.created"
	ActionToolUpdated = "platform.tool.updated"
	ActionToolDeleted = "platform.tool.deleted"
)

// The idempotency operation names, which scope a key to one kind of write. A
// key reused across two different operations is two different requests.
//
// EXPORTED because the handler passes them to readKey and lives in a different
// package. One spelling, declared once, rather than a second copy in handler.
const (
	OpToolCreate = "platform.tools.create"
	OpToolUpdate = "platform.tools.update"
	OpToolDelete = "platform.tools.delete"
)

// ToolPatch is a partial change. Every field is a pointer so "absent" and
// "sent" are distinguishable; ClearNote carries the third state that a
// pointer alone cannot — an explicit null.
type ToolPatch struct {
	Name      *string
	Subdomain *string
	Purpose   *string
	GroupKey  *string
	Note      *string
	ClearNote bool
	SortOrder *int
}

// CreateTool adds a directory entry.
func (s *Service) CreateTool(ctx context.Context, actor Actor, tool domain.Tool,
	key *idempotency.Key,
) (write.Result, error) {
	// Normalised then validated, in that order: a note of spaces is not an
	// over-long note, and refusing it for its length would name the wrong
	// problem.
	tool = tool.Normalise()
	if err := tool.Validate(); err != nil {
		return write.Result{}, err
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		order := 0
		if tool.SortOrder != nil {
			order = *tool.SortOrder
		} else {
			next, err := repository.NextSortOrder(ctx, tx, tool.GroupKey)
			if err != nil {
				return nil, audit.Entry{}, 0, err
			}
			order = next
		}

		stored, err := repository.InsertTool(ctx, tx, tool.Name, tool.Subdomain,
			tool.Purpose, tool.Note, tool.GroupKey, order)
		if err != nil {
			return nil, audit.Entry{}, 0, mapRepoError(err)
		}

		return ToolPayload{Tool: toolWire(stored)},
			audit.Entry{
				Actor:  actor.Subject,
				Action: ActionToolCreated,
				Target: stored.ID,
				// Counts, never content. The purpose and the note are the
				// operator's own text and already live one table away.
				Summary: map[string]int{"tools": 1},
			},
			http.StatusCreated, nil
	})
}

// UpdateTool applies a partial change.
func (s *Service) UpdateTool(ctx context.Context, actor Actor, id string, patch ToolPatch,
	key *idempotency.Key,
) (write.Result, error) {
	// Validated as a whole only where a field was sent: a PATCH that changes
	// the purpose must not be refused for a subdomain it did not touch.
	if patch.Subdomain != nil || patch.Name != nil || patch.Purpose != nil ||
		patch.GroupKey != nil || patch.Note != nil || patch.SortOrder != nil {
		probe := domain.Tool{
			Name: "placeholder", Subdomain: "placeholder", Purpose: "placeholder",
			GroupKey: "placeholder",
		}
		if patch.Name != nil {
			probe.Name = *patch.Name
		}
		if patch.Subdomain != nil {
			probe.Subdomain = *patch.Subdomain
		}
		if patch.Purpose != nil {
			probe.Purpose = *patch.Purpose
		}
		if patch.GroupKey != nil {
			probe.GroupKey = *patch.GroupKey
		}
		probe.Note = patch.Note
		probe.SortOrder = patch.SortOrder

		probe = probe.Normalise()
		if err := probe.Validate(); err != nil {
			return write.Result{}, err
		}
		// Write back what normalisation changed, so the stored row is the
		// normalised one rather than the raw input.
		if patch.Name != nil {
			patch.Name = &probe.Name
		}
		if patch.Subdomain != nil {
			patch.Subdomain = &probe.Subdomain
		}
		if patch.Purpose != nil {
			patch.Purpose = &probe.Purpose
		}
		if patch.GroupKey != nil {
			patch.GroupKey = &probe.GroupKey
		}
		if patch.Note != nil {
			patch.Note = probe.Note
		}
	}

	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		stored, err := repository.UpdateTool(ctx, tx, id, patch.Name, patch.Subdomain,
			patch.Purpose, patch.GroupKey, patch.Note, patch.ClearNote, patch.SortOrder)
		if err != nil {
			return nil, audit.Entry{}, 0, mapRepoError(err)
		}
		return ToolPayload{Tool: toolWire(stored)},
			audit.Entry{Actor: actor.Subject, Action: ActionToolUpdated, Target: stored.ID,
				Summary: map[string]int{"tools": 1}},
			http.StatusOK, nil
	})
}

// DeleteTool removes a directory entry and answers with it as it was.
func (s *Service) DeleteTool(ctx context.Context, actor Actor, id string,
	key *idempotency.Key,
) (write.Result, error) {
	return write.Perform(ctx, s.pool, key, func(ctx context.Context, tx pgx.Tx) (any, audit.Entry, int, error) {
		removed, err := repository.DeleteTool(ctx, tx, id)
		if err != nil {
			return nil, audit.Entry{}, 0, mapRepoError(err)
		}
		return ToolPayload{Tool: toolWire(removed)},
			audit.Entry{Actor: actor.Subject, Action: ActionToolDeleted, Target: removed.ID,
				Summary: map[string]int{"tools": 1}},
			http.StatusOK, nil
	})
}

// mapRepoError turns the repository's named constraints into this package's
// three outcomes.
//
// The distinction that matters: a duplicate subdomain is a CONFLICT because
// the request was valid and the directory's state refused it, while an unknown
// group is a REFUSAL because the caller named something that does not exist.
// A client retries the first after looking, and fixes the second.
func mapRepoError(err error) error {
	switch {
	case errors.Is(err, repository.ErrNoRow):
		return fmt.Errorf("%w: no tool with this id", ErrNotFound)
	case errors.Is(err, repository.ErrDuplicateSubdomain):
		return fmt.Errorf("%w: %s", ErrConflict, err)
	case errors.Is(err, repository.ErrUnknownGroup):
		return fmt.Errorf("%w: %s — add the group first, or use one of the existing keys", ErrRefused, err)
	case errors.Is(err, repository.ErrGroupHasTools):
		return fmt.Errorf("%w: %s — move or remove them first", ErrConflict, err)
	case errors.Is(err, repository.ErrInvalidSubdomain):
		return fmt.Errorf("%w: %s", ErrRefused, err)
	}
	return err
}
```

Add imports: `fmt`, `net/http`, `github.com/jackc/pgx/v5`, the module's
`domain`, and the kernel's `audit`, `idempotency`, `write`.

- [ ] **Step 5: Replace the handler stubs**

In `platform-api/internal/modules/tools/internal/handler/handler.go`, delete
the six `notYet` stubs and the `notYet` helper, and add:

First the four helpers every write shares. They live here rather than in Task 3
because nothing before this task calls them, and an unused unexported symbol
fails `golangci-lint`'s `unused` check:

```go
// maxBodyBytes caps a write. A directory entry is a few hundred bytes; this is
// generous by three orders of magnitude and still bounded.
const maxBodyBytes = 64 << 10

// beginWrite recovers the principal and reads the body once — it is needed
// twice, decoded into a request struct and digested for the idempotency key,
// and a decoder would consume the stream.
func (h *Handler) beginWrite(w http.ResponseWriter, r *http.Request) (*auth.Principal, []byte, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Unreachable behind Authenticate. Refused rather than assumed,
		// because the alternative is an audit row with an empty actor.
		h.log.ErrorContext(r.Context(), "a write route ran without a principal",
			slog.String("path", r.URL.Path))
		h.fail(w, r, httpx.Internal("request failed"))
		return nil, nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		h.fail(w, r, httpx.BadRequest("the request body could not be read"))
		return nil, nil, false
	}
	return principal, body, true
}

// readKey turns an optional Idempotency-Key header into a key. Optional
// deliberately: no header is a normal write. A header the caller got WRONG is
// an error, because a caller who meant to be protected must be told they were
// not.
func (h *Handler) readKey(r *http.Request, principal *auth.Principal, operation string, body []byte) (*idempotency.Key, error) {
	key, asked, err := idempotency.FromRequest(r, principal.Subject, operation, body)
	if err != nil {
		return nil, err
	}
	if !asked {
		return nil, nil
	}
	return &key, nil
}

// decode parses a body, rejecting anything the struct does not declare. An
// unknown field today is a field this service might mean something by
// tomorrow; the write-side twin of RejectUnknownParameters.
func decode(body []byte, into any) error {
	if len(body) == 0 {
		return httpx.BadRequest("a request body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return httpx.BadRequest("the request body is not the expected JSON: " + err.Error())
	}
	return nil
}
```

Add `bytes`, `encoding/json` and `io` to the file's imports — Task 3 left them
out deliberately, because nothing there needed them.

Then the handlers themselves:

```go
// createToolRequest is the create body. Pointers where absence is meaningful.
type createToolRequest struct {
	Name      string  `json:"name"`
	Subdomain string  `json:"subdomain"`
	Purpose   string  `json:"purpose"`
	Note      *string `json:"note"`
	GroupKey  string  `json:"group_key"`
	// Absent means "the end of its group". A non-pointer would make 0 —
	// legitimately the first position — indistinguishable from "unspecified".
	SortOrder *int `json:"sort_order"`
}

func (h *Handler) createTool(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request createToolRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	key, err := h.readKey(r, principal, service.OpToolCreate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.CreateTool(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		domain.Tool{
			Name: request.Name, Subdomain: request.Subdomain, Purpose: request.Purpose,
			Note: request.Note, GroupKey: request.GroupKey, SortOrder: request.SortOrder,
		}, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// updateToolRequest is the PATCH body.
//
// json.RawMessage for Note rather than *string, because THREE states have to
// be distinguishable and a pointer carries two: absent (leave it), null
// (clear it) and a string (set it). Without the raw form there is no way to
// remove a note.
type updateToolRequest struct {
	Name      *string         `json:"name"`
	Subdomain *string         `json:"subdomain"`
	Purpose   *string         `json:"purpose"`
	GroupKey  *string         `json:"group_key"`
	Note      json.RawMessage `json:"note"`
	SortOrder *int            `json:"sort_order"`
}

func (h *Handler) updateTool(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request updateToolRequest
	if err := decode(body, &request); err != nil {
		h.fail(w, r, err)
		return
	}
	key, err := h.readKey(r, principal, service.OpToolUpdate, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	patch := service.ToolPatch{
		Name: request.Name, Subdomain: request.Subdomain, Purpose: request.Purpose,
		GroupKey: request.GroupKey, SortOrder: request.SortOrder,
	}
	// The three states, read explicitly.
	if len(request.Note) > 0 {
		if string(request.Note) == "null" {
			patch.ClearNote = true
		} else {
			var note string
			if err := json.Unmarshal(request.Note, &note); err != nil {
				h.fail(w, r, httpx.BadRequest("note must be a string or null"))
				return
			}
			patch.Note = &note
		}
	}

	written, err := h.svc.UpdateTool(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		r.PathValue("id"), patch, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

func (h *Handler) deleteTool(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	// A DELETE carries no body, so the idempotency digest is over an empty
	// one — the key plus the path is what identifies the request.
	key, err := h.readKey(r, principal, service.OpToolDelete, body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.DeleteTool(r.Context(),
		service.Actor{Subject: principal.Subject, Email: principal.Email},
		r.PathValue("id"), key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}
```

The `Op*` constants are exported from `service` and the handler spells them
`service.OpToolCreate` / `OpToolUpdate` / `OpToolDelete`, as the code above
does. Task 5 adds `OpGroupCreate`, `OpGroupUpdate` and `OpGroupDelete` the same
way. (An earlier draft of this plan declared them unexported and then called
them bare from `handler`, which would not have compiled across the package
boundary.)

- [ ] **Step 6: Update the capability cases**

In `capability_test.go`, change the three tool write cases from
`http.StatusNotImplemented` to their real statuses:

```go
		"POST /v1/platform/tools": {
			body: `{"name":"Tempo","subdomain":"tempo","purpose":"Traces.","group_key":"observability"}`,
			want: http.StatusCreated,
		},
		"PATCH /v1/platform/tools/{id}": {
			body: `{"purpose":"Changed."}`,
			want: http.StatusOK,
		},
		"DELETE /v1/platform/tools/{id}": {want: http.StatusOK},
```

- [ ] **Step 7: Run the tests**

```bash
cd platform-api && go test ./internal/modules/tools/... -v 2>&1 | tail -40
```

Expected: every test PASSES, zero SKIP.

- [ ] **Step 8: Commit**

```bash
git add platform-api/internal/modules/tools/
git commit -m "feat(platform-api): add, edit and remove a tool without a deploy"
```

---

## Task 5: The group writes, and the golden files

**Files:**
- Modify: `platform-api/internal/modules/tools/internal/repository/tools.go`
- Modify: `platform-api/internal/modules/tools/internal/service/service.go`
- Modify: `platform-api/internal/modules/tools/internal/handler/handler.go`
- Modify: `platform-api/internal/modules/tools/internal/handler/capability_test.go`
- Create: `platform-api/internal/modules/tools/internal/handler/golden_test.go`
- Create: `platform-api/internal/modules/tools/internal/handler/testdata/*.json`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `service.CreateGroup/UpdateGroup/DeleteGroup` with the same
  signatures shape as the tool writes, and the committed golden files.

- [ ] **Step 1: Write the failing group-write tests**

Append to `handler_test.go`:

```go
func TestCreatingAGroupAnswers201(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPost, "/v1/platform/tool-groups",
		`{"key":"security","label":"Security"}`, nil)

	if got.status != http.StatusCreated {
		t.Fatalf("create group = %d, want 201: %s", got.status, got.raw)
	}
	group, _ := got.data(t)["group"].(map[string]any)
	if group["key"] != "security" {
		t.Errorf("created group = %v", group)
	}
	// Appended rather than inserted at the front: a new group must not
	// silently displace identity from the top of the page.
	if order, ok := group["sort_order"].(float64); !ok || order != 6 {
		t.Errorf("sort_order = %v, want 6 — after the five seeded groups", group["sort_order"])
	}
}

func TestDeletingAGroupThatStillHasToolsIs409(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodDelete, "/v1/platform/tool-groups/identity", "", nil)

	// The tools would be orphaned, and ON DELETE RESTRICT refuses. 409 rather
	// than 500: the request is valid and the state refuses it.
	if got.status != http.StatusConflict {
		t.Errorf("deleting a populated group = %d, want 409: %s", got.status, got.raw)
	}
	if got := len(a.get("/v1/platform/tool-groups").data(t)["groups"].([]any)); got != 5 {
		t.Errorf("the refused delete changed the group count to %d", got)
	}
}

func TestDeletingAnEmptyGroupSucceeds(t *testing.T) {
	a := serve(t)
	a.do(http.MethodPost, "/v1/platform/tool-groups", `{"key":"security","label":"Security"}`, nil)

	got := a.do(http.MethodDelete, "/v1/platform/tool-groups/security", "", nil)

	if got.status != http.StatusOK {
		t.Errorf("deleting an empty group = %d, want 200: %s", got.status, got.raw)
	}
}

func TestRenamingAGroupsLabelLeavesItsToolsAlone(t *testing.T) {
	a := serve(t)

	got := a.do(http.MethodPatch, "/v1/platform/tool-groups/cost", `{"label":"Spend"}`, nil)

	if got.status != http.StatusOK {
		t.Fatalf("patch group = %d, want 200: %s", got.status, got.raw)
	}
	group, _ := got.data(t)["group"].(map[string]any)
	if group["label"] != "Spend" {
		t.Errorf("label = %v, want Spend", group["label"])
	}
	// The key is the foreign key. A label change must not move a single tool.
	tools := a.get("/v1/platform/tools").data(t)["tools"].([]any)
	inCost := 0
	for _, raw := range tools {
		if tool, _ := raw.(map[string]any); tool["group_key"] == "cost" {
			inCost++
		}
	}
	if inCost != 2 {
		t.Errorf("cost has %d tools after a label change, want 2", inCost)
	}
}

func TestAGroupsKeyCannotBeChanged(t *testing.T) {
	a := serve(t)

	// Not supported, and refused loudly rather than ignored: every tool in the
	// group references the key, so renaming it is a migration rather than an
	// edit. Add the new group, move the tools, remove the old one.
	got := a.do(http.MethodPatch, "/v1/platform/tool-groups/cost", `{"key":"spend"}`, nil)

	if got.status != http.StatusBadRequest {
		t.Errorf("changing a group key = %d, want 400: %s", got.status, got.raw)
	}
}
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd platform-api && go test ./internal/modules/tools/internal/handler/... -run 'Group' -v
```

Expected: 501s where 200/201/400/409 was wanted.

- [ ] **Step 3: Add the group repository writes**

Append to `repository/tools.go`:

```go
// NextGroupSortOrder is the position a new group takes: after the existing
// ones. A new group must not silently displace identity from the top.
func NextGroupSortOrder(ctx context.Context, q Queryer) (int, error) {
	var next int
	err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platform_tool_groups`).Scan(&next)
	return next, err
}

// InsertGroup adds a heading.
func InsertGroup(ctx context.Context, e Execer, key, label string, sortOrder int) (Group, error) {
	var g Group
	err := e.QueryRow(ctx,
		`INSERT INTO platform_tool_groups (key, label, sort_order) VALUES ($1, $2, $3)
		 RETURNING key, label, sort_order`, key, label, sortOrder).
		Scan(&g.Key, &g.Label, &g.SortOrder)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Group{}, ErrDuplicateGroup
		}
		return Group{}, err
	}
	return g, nil
}

// ErrDuplicateGroup is the group primary key, named.
var ErrDuplicateGroup = errors.New("a group with this key already exists")

// UpdateGroup changes a heading's label or position. The KEY is not
// changeable — see the handler.
func UpdateGroup(ctx context.Context, e Execer, key string, label *string, sortOrder *int) (Group, error) {
	var g Group
	err := e.QueryRow(ctx,
		`UPDATE platform_tool_groups
		    SET label      = COALESCE($2, label),
		        sort_order = COALESCE($3, sort_order),
		        updated_at = now()
		  WHERE key = $1
		RETURNING key, label, sort_order`, key, label, sortOrder).
		Scan(&g.Key, &g.Label, &g.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Group{}, ErrNoRow
	}
	return g, err
}

// DeleteGroup removes a heading, and is refused by the foreign key if any tool
// still references it.
//
// It maps 23503 ITSELF rather than deferring to classify, and that is the whole
// point of this function having its own error handling. Migration 0031 defines
// exactly one foreign key, `platform_tools_group_key_fkey`, and Postgres reports
// that same constraint name in BOTH directions — inserting a tool into a group
// that does not exist, and deleting a group that still has tools. Neither the
// constraint name nor the table name distinguishes them. The DIRECTION is known
// here at the call site and nowhere else, so this is the only place the
// distinction can be drawn correctly. classify's 23503 branch means "unknown
// group", which is right for every caller except this one.
func DeleteGroup(ctx context.Context, e Execer, key string) (Group, error) {
	var g Group
	err := e.QueryRow(ctx,
		`DELETE FROM platform_tool_groups WHERE key = $1 RETURNING key, label, sort_order`, key).
		Scan(&g.Key, &g.Label, &g.SortOrder)
	if errors.Is(err, pgx.ErrNoRows) {
		return Group{}, ErrNoRow
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return Group{}, ErrGroupHasTools
		}
		return Group{}, classify(err)
	}
	return g, nil
}
```

Extend `mapRepoError` in the service with:

```go
	case errors.Is(err, repository.ErrDuplicateGroup):
		return fmt.Errorf("%w: %s", ErrConflict, err)
```

and note that `ErrNoRow` from a group write should say "no group with this
key" rather than "no tool with this id" — split `mapRepoError` into
`mapToolError` and `mapGroupError`, identical but for that one message. Two
near-copies are the right shape here: the alternative is a parameter that
exists only to pick a noun.

- [ ] **Step 4: Add the group service writes and handlers**

Follow the tool writes exactly — and "exactly" includes the part that is easy to
skip, because the group path has no compiler pressure to make you do it:
**`CreateGroup` builds a `domain.Group`, calls `Normalise()` then `Validate()`
before touching the database, and `UpdateGroup` does the same for the fields
actually sent** (the `probe` pattern `UpdateTool` uses, writing normalised
values back onto the patch). Without this the whole `Group` half of the domain
package is dead code: `key text PRIMARY KEY` and `label text NOT NULL` both
accept the empty string, so `{"key":"","label":""}` would answer 201 and create
a group with an empty key and a blank heading, and `{"key":"Not A Key"}` would
put spaces into a key every tool in the group references.

`createGroupRequest.SortOrder` must be wired through to `CreateGroup`, not
declared and dropped. A silently-ignored field is exactly what declaring-and-
refusing `key` exists to prevent; reintroducing it one field over would be
worse than omitting it. Actions `platform.tool_group.created`,
`.updated`, `.deleted`; operations `platform.tool_groups.create`, `.update`,
`.delete`; payload `GroupPayload{Group: groupWire(stored)}`; statuses 201, 200,
200. The PATCH body is:

```go
// updateGroupRequest is the group PATCH body.
//
// `key` is declared and REFUSED rather than omitted from the struct. Omitted,
// DisallowUnknownFields would answer "unknown field key", which reads as a
// typo; declared, the refusal can say why a key cannot be renamed and what to
// do instead.
type updateGroupRequest struct {
	Key       *string `json:"key"`
	Label     *string `json:"label"`
	SortOrder *int    `json:"sort_order"`
}
```

and the handler begins:

```go
	if request.Key != nil {
		h.fail(w, r, httpx.BadRequest(
			"a group's key cannot be changed: every tool in the group references it. "+
				"Add the new group, move the tools to it, then remove the old one"))
		return
	}
```

Group create/patch/delete take the key from `r.PathValue("key")`.

- [ ] **Step 5: Update the remaining capability cases**

```go
		"POST /v1/platform/tool-groups": {
			body: `{"key":"security","label":"Security"}`,
			want: http.StatusCreated,
		},
		"PATCH /v1/platform/tool-groups/{key}": {
			body: `{"label":"Changed"}`,
			want: http.StatusOK,
		},
		// `reference` is the group `path` fills in, and it has three tools —
		// so DELETE is refused by the foreign key. The capability test asks
		// only whether the gate let the request through, and 409 proves it
		// did as well as 200 would.
		"DELETE /v1/platform/tool-groups/{key}": {want: http.StatusConflict},
```

- [ ] **Step 6: Write the golden test**

Create `platform-api/internal/modules/tools/internal/handler/golden_test.go`:

```go
package handler_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// Golden responses: the module's actual output, committed.
//
// The console's parsers cannot run against a Go process in CI, but they can be
// written against its RECORDED output — produced by the real router, over a
// real database, through the real envelope. Committed rather than generated on
// demand so a contract change is VISIBLE IN A DIFF.
//
//	go test ./internal/modules/tools/internal/handler/... -update-golden
//
// Scoped to this package: the domain and repository packages build their own
// test binaries, which do not define this flag.
var updateGolden = flag.Bool("update-golden", false,
	"rewrite the golden response files; read the diff before committing")

var volatile = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`"id":"[0-9a-f-]{36}"`), `"id":"<uuid>"`},
	{regexp.MustCompile(`"timestamp":"[^"]+"`), `"timestamp":"<timestamp>"`},
	{regexp.MustCompile(`"request_id":"[^"]+"`), `"request_id":"<request-id>"`},
}

func stabilise(body []byte) []byte {
	for _, v := range volatile {
		body = v.pattern.ReplaceAll(body, []byte(v.replacement))
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, body, "", "  "); err != nil {
		return body
	}
	return append(pretty.Bytes(), '\n')
}

func assertGolden(t *testing.T, name string, body string) {
	t.Helper()
	path := filepath.Join("testdata", name+".json")
	got := stabilise([]byte(body))

	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("creating testdata: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v — run with -update-golden to create it", path, err)
	}
	if string(got) != string(want) {
		t.Errorf("%s changed.\n\ngot:\n%s\nwant:\n%s\n\n"+
			"If this change is intended, re-run with -update-golden and commit the diff. "+
			"These files are the contract the console's parser is written against.",
			path, got, want)
	}
}

func TestGoldenResponses(t *testing.T) {
	a := serve(t)

	assertGolden(t, "tools", a.get("/v1/platform/tools").raw)
	assertGolden(t, "tool-groups", a.get("/v1/platform/tool-groups").raw)

	created := a.do(http.MethodPost, "/v1/platform/tools",
		`{"name":"Tempo","subdomain":"tempo","purpose":"Distributed traces.","group_key":"observability"}`, nil)
	assertGolden(t, "tool-created", created.raw)

	id := a.toolID("tempo")
	assertGolden(t, "tool-updated",
		a.do(http.MethodPatch, "/v1/platform/tools/"+id, `{"purpose":"Traces, distributed."}`, nil).raw)
	assertGolden(t, "tool-deleted",
		a.do(http.MethodDelete, "/v1/platform/tools/"+id, "", nil).raw)

	assertGolden(t, "group-created",
		a.do(http.MethodPost, "/v1/platform/tool-groups", `{"key":"security","label":"Security"}`, nil).raw)
	assertGolden(t, "group-updated",
		a.do(http.MethodPatch, "/v1/platform/tool-groups/security", `{"label":"Security and access"}`, nil).raw)
	// A throwaway group, deleted — NOT one of the seeded five, which other
	// goldens above read. The 409 delete is captured separately below; a
	// successful one needs an empty group to act on.
	assertGolden(t, "group-deleted",
		a.do(http.MethodDelete, "/v1/platform/tool-groups/security", "", nil).raw)
	assertGolden(t, "error-group-not-found",
		a.do(http.MethodPatch, "/v1/platform/tool-groups/no-such-group", `{"label":"x"}`, nil).raw)
	assertGolden(t, "error-duplicate-group",
		a.do(http.MethodPost, "/v1/platform/tool-groups", `{"key":"identity","label":"Identity again"}`, nil).raw)

	// Every error shape. A client's error handling is written against these
	// and exercised less than its success path, so a change here is likelier
	// to go unnoticed.
	assertGolden(t, "error-unknown-parameter", a.get("/v1/platform/tools?group=identity").raw)
	assertGolden(t, "error-subdomain-not-a-label",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"https://grafana.tesserix.app","purpose":"x","group_key":"reference"}`, nil).raw)
	assertGolden(t, "error-unknown-group",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"x","purpose":"x","group_key":"no-such-group"}`, nil).raw)
	assertGolden(t, "error-duplicate-subdomain",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"auth","purpose":"x","group_key":"identity"}`, nil).raw)
	assertGolden(t, "error-unknown-field",
		a.do(http.MethodPost, "/v1/platform/tools",
			`{"name":"x","subdomain":"x","purpose":"x","group_key":"reference","status":"up"}`, nil).raw)
	assertGolden(t, "error-tool-not-found",
		a.do(http.MethodPatch, "/v1/platform/tools/00000000-0000-0000-0000-000000000000",
			`{"name":"x"}`, nil).raw)
	assertGolden(t, "error-group-has-tools",
		a.do(http.MethodDelete, "/v1/platform/tool-groups/identity", "", nil).raw)
	assertGolden(t, "error-group-key-immutable",
		a.do(http.MethodPatch, "/v1/platform/tool-groups/cost", `{"key":"spend"}`, nil).raw)
}
```

- [ ] **Step 7: Generate the golden files and READ THE DIFF**

```bash
cd platform-api && go test ./internal/modules/tools/internal/handler/... -update-golden
git diff --stat platform-api/internal/modules/tools/internal/handler/testdata/
git diff platform-api/internal/modules/tools/internal/handler/testdata/ | head -200
```

Read every file. Check specifically: `tools` has 15 entries and `note` is
`null` rather than absent on the thirteen without one; `[]` appears nowhere as
`null`; every key is snake_case; no error message leaks a Postgres constraint
name.

- [ ] **Step 8: Run everything**

```bash
cd platform-api && go build ./... && go vet ./... && go test ./... 2>&1 | tail -20
```

Expected: all green, zero skips.

- [ ] **Step 9: Commit**

```bash
git add platform-api/internal/modules/tools/
git commit -m "feat(platform-api): manage tool groups, and record the module's wire contract"
```

---

## Task 6: The console loader

**Files:**
- Create: `apps/console/lib/tools-directory.ts`
- Test: `apps/console/lib/tools-directory.test.ts`

**Interfaces:**
- Consumes: `platformApiOrigin()` and `platformRequestWithMeta()` from
  `apps/console/lib/platform-api.ts`; `INTERNAL_TOOLS`, `TOOL_GROUPS` from
  `@tesserix/console-core`.
- Produces: `readToolsDirectory(): Promise<ToolsDirectory>`,
  `interface ToolsDirectory { groups: DirectoryGroup[]; tools: DirectoryTool[]; source: "platform-api" | "builtin" }`,
  `interface DirectoryTool { id: string; name: string; subdomain: string; purpose: string; note: string | null; groupKey: string }`,
  `interface DirectoryGroup { key: string; label: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/console/lib/tools-directory.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ORIGIN = process.env.PLATFORM_API_ORIGIN;

afterEach(() => {
  process.env.PLATFORM_API_ORIGIN = ORIGINAL_ORIGIN;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  return import("./tools-directory");
}

describe("readToolsDirectory", () => {
  it("returns the built-in directory when PLATFORM_API_ORIGIN is unset", async () => {
    delete process.env.PLATFORM_API_ORIGIN;
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // Unset is byte-for-byte the old behaviour, which is what makes this whole
    // phase revert by removing one variable rather than by reverting code.
    expect(directory.source).toBe("builtin");
    expect(directory.tools).toHaveLength(15);
    expect(directory.groups.map((g) => g.key)).toEqual([
      "identity",
      "observability",
      "delivery",
      "cost",
      "reference",
    ]);
  });

  it("reads the platform API when the origin is set", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("tool-groups")
          ? { success: true, data: { groups: [{ key: "identity", label: "Identity", sort_order: 1 }] } }
          : {
              success: true,
              data: {
                tools: [
                  {
                    id: "1",
                    name: "Zitadel",
                    subdomain: "auth",
                    purpose: "Identity platform.",
                    note: null,
                    group_key: "identity",
                    sort_order: 1,
                  },
                ],
              },
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    expect(directory.source).toBe("platform-api");
    expect(directory.tools).toHaveLength(1);
    // snake_case on the wire, camelCase in the console: the translation
    // happens once, here, rather than in each renderer.
    expect(directory.tools[0]).toMatchObject({ subdomain: "auth", groupKey: "identity" });
  });

  it("falls back to the built-in directory, LABELLED, when the API fails", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // The directory survives an outage — that is the point of the fallback.
    expect(directory.tools).toHaveLength(15);
    // And it says so. A silent fallback is two lists that disagree with
    // nobody able to tell which one they are looking at.
    expect(directory.source).toBe("builtin");
  });

  it("falls back rather than throwing when the payload is the wrong shape", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: { tools: "not an array" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // A malformed success is a failure. The home page must not blow up over a
    // directory of links.
    expect(directory.source).toBe("builtin");
    expect(directory.tools).toHaveLength(15);
  });

  it("drops a tool whose group is not declared", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("tool-groups")
          ? { success: true, data: { groups: [{ key: "identity", label: "Identity", sort_order: 1 }] } }
          : {
              success: true,
              data: {
                tools: [
                  { id: "1", name: "Zitadel", subdomain: "auth", purpose: "x", note: null, group_key: "identity", sort_order: 1 },
                  { id: "2", name: "Orphan", subdomain: "orphan", purpose: "x", note: null, group_key: "ghost", sort_order: 1 },
                ],
              },
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // The foreign key makes this unreachable through the API, but the console
    // renders whatever it is handed and an orphan would be a card under no
    // heading. Dropped rather than shown under an invented one.
    expect(directory.tools.map((t) => t.subdomain)).toEqual(["auth"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/console && npx vitest run lib/tools-directory.test.ts
```

Expected: cannot resolve `./tools-directory`.

- [ ] **Step 3: Write the loader**

Create `apps/console/lib/tools-directory.ts`:

```ts
// `server-only`: this module reads an operator's bearer token on one branch.
// A client component importing it must fail the build, not ship server code to
// the browser — see #299, and see the note in lib/search.ts about why the
// palette receives rows as a prop rather than importing this.
import "server-only";

import { INTERNAL_TOOLS, TOOL_GROUPS } from "@tesserix/console-core";
import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";

/** One directory entry, in the console's own casing. */
export interface DirectoryTool {
  readonly id: string;
  readonly name: string;
  readonly subdomain: string;
  readonly purpose: string;
  readonly note: string | null;
  readonly groupKey: string;
}

/** One heading. */
export interface DirectoryGroup {
  readonly key: string;
  readonly label: string;
}

/**
 * Where the rendered directory came from.
 *
 * `builtin` is not an error state — it is the correct answer when
 * `PLATFORM_API_ORIGIN` is unset — but it IS a state the page tells the
 * operator about when the API was supposed to answer and did not. Two lists
 * that can disagree must never disagree silently.
 */
export type DirectorySource = "platform-api" | "builtin";

export interface ToolsDirectory {
  readonly groups: readonly DirectoryGroup[];
  readonly tools: readonly DirectoryTool[];
  readonly source: DirectorySource;
}

/**
 * The tools directory, from the platform API or from the code literal.
 *
 * Two backends behind one signature, chosen by `PLATFORM_API_ORIGIN` — the
 * same switch `fetchTickets` and the CRM queues use, and for the same reason:
 * UNSET IS BYTE-FOR-BYTE THE OLD BEHAVIOUR, so this phase reverts by removing
 * one variable rather than by reverting code.
 *
 * # Why a failure falls back instead of surfacing
 *
 * This is a directory of links, not a queue of work. An operator who cannot
 * reach Grafana because the console could not reach its own API is worse off
 * than one shown a slightly stale list — and the built-in list is not
 * plausibly stale by much, since it is the seed. So the failure is absorbed
 * and LABELLED rather than rendered as an error surface.
 *
 * That is a decision about THIS resource and does not generalise: a CRM queue
 * falling back to a hardcoded list would be indefensible. Per the rule at the
 * top of lib/crm-queues.ts, this is handled at the seam because the refusal
 * has an existing console-vocabulary equivalent — the built-in directory — so
 * neither error classifier needs to learn a new condition.
 */
export async function readToolsDirectory(): Promise<ToolsDirectory> {
  if (!platformApiOrigin()) {
    return builtin();
  }
  try {
    const [toolsBody, groupsBody] = await Promise.all([
      platformRequestWithMeta("tools directory", "/v1/platform/tools"),
      platformRequestWithMeta("tool groups", "/v1/platform/tool-groups"),
    ]);
    return parse(toolsBody.data, groupsBody.data);
  } catch (cause) {
    // Server-side only: this runs in a React Server Component, so it lands
    // in the app's logs and never in the response. The `[console]` prefix and
    // the bare console.* call are this app's convention — see
    // lib/db-read-error.ts:147; there is no logger module.
    console.warn("[console] the tools directory could not be read from the platform API", cause);
    return builtin();
  }
}

/** The code literal, which is also the seed migration 0031 applied. */
function builtin(): ToolsDirectory {
  return {
    groups: TOOL_GROUPS.map((group) => ({ key: group.key, label: group.label })),
    tools: INTERNAL_TOOLS.map((tool) => ({
      // The literal has no ids. A synthetic one keyed on the subdomain — which
      // is unique by construction — keeps React's keys stable without
      // pretending a database row exists.
      id: `builtin:${tool.subdomain}`,
      name: tool.name,
      subdomain: tool.subdomain,
      purpose: tool.purpose,
      note: tool.note ?? null,
      groupKey: tool.group,
    })),
    source: "builtin",
  };
}

/**
 * Turn the two payloads into the console's shape, or throw.
 *
 * Throwing is caught by the caller and becomes the labelled fallback. A
 * malformed success is a failure: a `tools` that is not an array would
 * otherwise reach the renderer and throw there, where the fallback cannot
 * catch it.
 */
function parse(toolsData: unknown, groupsData: unknown): ToolsDirectory {
  const rawGroups = arrayAt(groupsData, "groups");
  const rawTools = arrayAt(toolsData, "tools");

  const groups: DirectoryGroup[] = rawGroups.map((row) => ({
    key: str(row, "key"),
    label: str(row, "label"),
  }));
  const declared = new Set(groups.map((group) => group.key));

  const tools: DirectoryTool[] = rawTools
    .map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      subdomain: str(row, "subdomain"),
      purpose: str(row, "purpose"),
      note: nullableStr(row, "note"),
      groupKey: str(row, "group_key"),
    }))
    // A tool whose group is not declared would render as a card under no
    // heading. The foreign key makes it unreachable through the API; this is
    // the render-side belt, matching the one in internal-tools.tsx.
    .filter((tool) => declared.has(tool.groupKey));

  return { groups, tools, source: "platform-api" };
}

function arrayAt(data: unknown, key: string): Record<string, unknown>[] {
  const container = data as Record<string, unknown> | null;
  const value = container?.[key];
  if (!Array.isArray(value)) {
    throw new Error(`the tools directory payload has no \`${key}\` array`);
  }
  return value as Record<string, unknown>[];
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` is ${typeof value}, expected a string`);
  }
  return value;
}

function nullableStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` is ${typeof value}, expected a string or null`);
  }
  return value;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/console && npx vitest run lib/tools-directory.test.ts
```

Expected: five PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/lib/tools-directory.ts apps/console/lib/tools-directory.test.ts
git commit -m "feat(console): read the tools directory from the platform API, with a labelled fallback"
```

---

## Task 7: The home page cards

**Files:**
- Modify: `apps/console/components/internal-tools.tsx`
- Modify: `apps/console/app/(console)/page.tsx`
- Test: `apps/console/components/internal-tools.render.test.tsx` (create)

**Interfaces:**
- Consumes: `ToolsDirectory`, `DirectoryTool`, `DirectoryGroup` (Task 6).
- Produces: `<InternalTools baseDomain={string} directory={ToolsDirectory} />`.

- [ ] **Step 1: Write the failing render test**

Create `apps/console/components/internal-tools.render.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InternalTools } from "./internal-tools";
import type { ToolsDirectory } from "@/lib/tools-directory";

const directory = (source: ToolsDirectory["source"]): ToolsDirectory => ({
  source,
  groups: [
    { key: "identity", label: "Identity and secrets" },
    { key: "cost", label: "Cost" },
  ],
  tools: [
    { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity.", note: null, groupKey: "identity" },
    { id: "2", name: "Kubecost", subdomain: "kubecost", purpose: "Spend.", note: null, groupKey: "cost" },
  ],
});

describe("InternalTools", () => {
  it("derives each link from the configured base domain", () => {
    render(<InternalTools baseDomain="dev.tesserix.app" directory={directory("platform-api")} />);

    // The property the whole schema protects: a non-production console must
    // not hand operators links into production.
    expect(screen.getByRole("link", { name: /Zitadel/ })).toHaveAttribute(
      "href",
      "https://auth.dev.tesserix.app",
    );
  });

  it("says nothing about its source when the API answered", () => {
    render(<InternalTools baseDomain="tesserix.app" directory={directory("platform-api")} />);

    expect(screen.queryByText(/built-in list/i)).not.toBeInTheDocument();
  });

  it("says so when it fell back to the built-in list", () => {
    render(<InternalTools baseDomain="tesserix.app" directory={directory("builtin")} />);

    // The cost of a fallback is two lists that can disagree. This is what
    // stops them disagreeing SILENTLY.
    expect(screen.getByText(/built-in list/i)).toBeInTheDocument();
  });

  it("skips a group with no tools rather than rendering a bare heading", () => {
    const empty: ToolsDirectory = {
      source: "platform-api",
      groups: [{ key: "identity", label: "Identity and secrets" }, { key: "ghost", label: "Ghost" }],
      tools: [
        { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity.", note: null, groupKey: "identity" },
      ],
    };

    render(<InternalTools baseDomain="tesserix.app" directory={empty} />);

    // A heading over nothing reads as a loading failure rather than an
    // absence. This belt used to be backed by a data test that made the case
    // impossible; with groups in a table it is the only thing left.
    expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
    expect(screen.getByText("Identity and secrets")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/console && npx vitest run components/internal-tools.render.test.tsx
```

Expected: type error — `InternalTools` takes no `directory` prop.

- [ ] **Step 3: Change the component to take rows**

In `apps/console/components/internal-tools.tsx`:

- Delete the `TOOL_GROUPS`, `toolsInGroup` and `type InternalTool` imports from
  `@tesserix/console-core`; keep `toolUrl`.
- Add `import type { DirectoryTool, ToolsDirectory } from "@/lib/tools-directory";`
  — a **type-only** import, so nothing from the `server-only` module reaches
  the bundle.
- Change `ToolLink` to take a `DirectoryTool`. **`toolUrl` must be widened
  first — this is required, not conditional.** Its signature is
  `toolUrl(tool: InternalTool, baseDomain: string)` (`tools.ts:163`), and
  `InternalTool` requires a `group` field that `DirectoryTool` does not have
  (it has `groupKey`), so a `DirectoryTool` does NOT satisfy it structurally.
  In `packages/console-core/src/tools.ts` change the parameter to
  `tool: { readonly subdomain: string }` — the body reads only `tool.subdomain`,
  so every existing caller still type-checks and the function stops caring
  which of the two shapes it is handed.
- Change the component signature to
  `{ baseDomain, directory }: { baseDomain: string; directory: ToolsDirectory }`.
- Replace the `TOOL_GROUPS.map` with `directory.groups.map`, and
  `toolsInGroup(group.key)` with
  `directory.tools.filter((tool) => tool.groupKey === group.key)`.
- Keep the empty-group `return null`, and update its comment: the data tests no
  longer forbid the case, so this is now the only thing standing between an
  empty group and a bare heading.
- Add, immediately under the section's `<p>` description:

```tsx
      {directory.source === "builtin" && (
        // Not an error surface. The directory is correct and usable; what is
        // being reported is that it could not be confirmed against the live
        // one, which is the difference between a stale list and a wrong one.
        <p className="text-xs text-muted-foreground">
          Live directory unavailable — showing the built-in list.
        </p>
      )}
```

- [ ] **Step 4: Fetch it on the page**

In `apps/console/app/(console)/page.tsx`:

```tsx
import { EstateMap } from "@/components/estate-map";
import { InternalTools } from "@/components/internal-tools";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { readToolsDirectory } from "@/lib/tools-directory";

export default async function ConsoleHome() {
  // The tools directory is data now (#318): it comes from platform_tools
  // through the platform API, falling back to the built-in list. The estate
  // map is still static — its context list is a validation vocabulary the CRM
  // writes against, and moving it is a separate decision.
  const directory = await readToolsDirectory();

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader title="Platform" description="The estate at a glance." />
      {/* ...the existing comment block about stat tiles, unchanged... */}
      <EstateMap />
      {/* Base domain is configuration, not a constant: a non-production console
          must not hand operators links into production tools. */}
      <InternalTools
        baseDomain={process.env.NEXT_PUBLIC_TOOLS_DOMAIN ?? "tesserix.app"}
        directory={directory}
      />
    </div>
  );
}
```

Keep the existing comment block above `<EstateMap />` verbatim; only the
function signature, the fetch and the `directory` prop are new.

- [ ] **Step 5: Run the tests and the build**

```bash
cd apps/console && npx vitest run components/internal-tools.render.test.tsx && npx next build
```

`next build` matters here specifically: this is the commit that first makes a
page `async` and pulls a `server-only` module into its import graph.

- [ ] **Step 6: Commit**

```bash
git add apps/console/components/internal-tools.tsx \
        apps/console/components/internal-tools.render.test.tsx \
        "apps/console/app/(console)/page.tsx"
git commit -m "feat(console): render the tools cards from the platform API"
```

---

## Task 8: The command palette

**Files:**
- Modify: `apps/console/lib/search.ts:147`
- Modify: `apps/console/components/nav/command-palette.tsx`
- Modify: `apps/console/components/nav/console-header.tsx`
- Modify: `apps/console/app/(console)/layout.tsx`
- Test: `apps/console/lib/search.test.ts`, `apps/console/components/nav/command-palette.render.test.tsx`

**Interfaces:**
- Consumes: `readToolsDirectory` (Task 6), `DirectoryTool` (Task 6).
- Produces: `toolEntries(baseDomain: string, tools: readonly DirectoryTool[]): SearchEntry[]`;
  a `tools` prop on `CommandPalette` and `ConsoleHeader`.

**This is the task the spec calls the trap.** `command-palette.tsx` is
`"use client"`. Nothing in this task may make `lib/search.ts` import
`lib/tools-directory.ts` — the rows travel as a serialisable prop down the path
`toolsBaseDomain` already takes.

- [ ] **Step 1: Write the failing test**

Add to `apps/console/lib/search.test.ts`:

```ts
import type { DirectoryTool } from "@/lib/tools-directory";

const rows: DirectoryTool[] = [
  { id: "1", name: "Zitadel", subdomain: "auth", purpose: "Identity platform.", note: null, groupKey: "identity" },
  { id: "2", name: "Kargo", subdomain: "kargo", purpose: "Promotes images.", note: null, groupKey: "delivery" },
];

describe("toolEntries", () => {
  it("builds an entry per supplied row rather than from the code literal", () => {
    const entries = toolEntries("tesserix.app", rows);

    // The whole point of the cutover: a tool added through CRUD is findable in
    // the palette the same minute. Reading INTERNAL_TOOLS here would have
    // meant the cards showed reality and the palette showed 2026.
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label)).toEqual(["Zitadel", "Kargo"]);
  });

  it("derives the href from the base domain", () => {
    const entries = toolEntries("dev.tesserix.app", rows);

    expect(entries[0].href).toBe("https://auth.dev.tesserix.app");
  });

  it("returns nothing when the directory is empty", () => {
    expect(toolEntries("tesserix.app", [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/console && npx vitest run lib/search.test.ts
```

Expected: `toolEntries` takes one argument.

- [ ] **Step 3: Change `toolEntries`**

In `apps/console/lib/search.ts`:

- Remove `INTERNAL_TOOLS` and `type InternalTool` from the
  `@tesserix/console-core` import. Keep `toolUrl`.
- Add `import type { DirectoryTool } from "@/lib/tools-directory";` — **type
  only**. A value import would pull `server-only` into the client bundle and
  break the build, which is the outcome `import "server-only"` exists to
  produce.
- Change the signature and body:

```ts
export function toolEntries(
  baseDomain: string,
  tools: readonly DirectoryTool[],
): SearchEntry[] {
  return tools.map((tool) => ({
    id: `tool:${tool.subdomain}`,
    kind: "tool",
    label: tool.name,
    hint: toolHint(tool),
    href: toolUrl(tool, baseDomain),
    external: true,
    disabled: false,
    keywords: toolKeywords(tool),
    capability: "read", // deliberate — see the doc comment above
  }));
}
```

- Update `toolHint` and `toolKeywords` to take a `DirectoryTool`. They read
  `purpose`, `note` and `name`/`subdomain`; the field names are unchanged
  except `group` → `groupKey`, so adjust only if they read the group.
- Extend the existing doc comment above `toolEntries` with:

```
 * The rows are a PARAMETER rather than an import, and that is structural
 * rather than stylistic: this module is imported by command-palette.tsx,
 * which is `"use client"`. Importing lib/tools-directory here would pull a
 * `server-only` module into the browser bundle — the #299 failure — so the
 * directory is fetched in the console layout and travels down as a prop,
 * the same path toolsBaseDomain already takes.
```

- [ ] **Step 4: Thread the prop through**

`command-palette.tsx`:

```tsx
  readonly toolsBaseDomain: string;
  // Fetched server-side in app/(console)/layout.tsx. A prop rather than an
  // import because this is a client component — see lib/search.ts.
  readonly tools: readonly DirectoryTool[];
```

and at line 76:

```tsx
    () => visibleTo(toolEntries(toolsBaseDomain, tools), capabilities, enforceCapabilities),
    [capabilities, enforceCapabilities, toolsBaseDomain, tools],
```

Add `import type { DirectoryTool } from "@/lib/tools-directory";`.

`console-header.tsx`: add `readonly tools: readonly DirectoryTool[];` to its
props and pass it straight through to `CommandPalette`. Give it no default —
an empty default would make a plumbing mistake look like an empty directory.

`app/(console)/layout.tsx`: make the layout `async` if it is not already, and:

```tsx
  const directory = await readToolsDirectory();
```

then pass `tools={directory.tools}` alongside the existing `toolsBaseDomain`.

**Note on the double fetch:** the layout and the home page each call
`readToolsDirectory()`, so a visit to `/` reads the directory twice. Leave it.
Next's request-scoped `fetch` cache already collapses two identical GETs within
one render pass, and reaching for `React.cache` here would add a memoisation
layer to save a request that is likely already saved. If a trace later shows
two round trips, that is the moment to wrap it — not before.

- [ ] **Step 5: Update the palette's render test**

In `command-palette.render.test.tsx`, add `tools: []` to the props object at
line 19, and add one case:

```tsx
it("offers a tool that exists only in the database", () => {
  render(
    <CommandPalette
      {...baseProps}
      tools={[
        { id: "9", name: "Tempo", subdomain: "tempo", purpose: "Traces.", note: null, groupKey: "observability" },
      ]}
    />,
  );

  // Tempo is in no literal anywhere. If this passes, the palette is reading
  // the database rather than console-core.
  expect(screen.getByText("Tempo")).toBeInTheDocument();
});
```

Match `baseProps` to whatever that file already calls its props object.

- [ ] **Step 6: Run the tests AND the build**

```bash
cd apps/console && npx vitest run && npx next build
```

`next build` is not optional on this task. `tsc` resolves `import type` and a
value import identically; only the bundler distinguishes them, and a value
import of `tools-directory` here is exactly #299.

- [ ] **Step 7: Commit**

```bash
git add apps/console/lib/search.ts apps/console/lib/search.test.ts \
        apps/console/components/nav/command-palette.tsx \
        apps/console/components/nav/command-palette.render.test.tsx \
        apps/console/components/nav/console-header.tsx \
        "apps/console/app/(console)/layout.tsx"
git commit -m "feat(console): search the database-backed tools directory from the palette"
```

---

## Task 9: The console-core tests, and the whole-system check

**Files:**
- Modify: `packages/console-core/src/tools.test.ts`
- Modify: `packages/console-core/src/tools.ts` (comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This task changes what the tests MEAN.

- [ ] **Step 1: Rewrite the group-coverage tests as integrity tests**

`INTERNAL_TOOLS` and `TOOL_GROUPS` are now the FALLBACK rather than the source
of truth, and the tests should say so. In
`packages/console-core/src/tools.test.ts`:

- Keep `toolUrl`'s tests unchanged — host derivation still lives in code and is
  the property the whole schema protects.
- Keep "no duplicate subdomains" and "every tool is in a declared group",
  and add to each a comment naming what now enforces it in the live path:

```ts
  // Still asserted, but it is no longer the only guarantee: platform_tools has
  // a UNIQUE constraint on subdomain (migration 0031). This keeps the FALLBACK
  // list honest — it is what renders when the platform API cannot be reached.
```

```ts
  // The live path's guarantee is now a foreign key with ON DELETE RESTRICT.
  // This asserts the same thing about the fallback, which no foreign key
  // covers.
```

- The "no empty group" test keeps its assertion and gains the honest caveat:

```ts
  // NOTE: with groups in platform_tool_groups this can no longer be
  // guaranteed for the LIVE directory — a foreign key cannot express "and at
  // least one tool references you". The renderer skips an empty group
  // (components/internal-tools.tsx) and internal-tools.render.test.tsx covers
  // that. What this test still guarantees is the fallback.
```

- Add one new test:

```ts
it("keeps the fallback list in step with the seed migration", async () => {
  // The literal and migration 0031's seed are two copies of one directory. A
  // tool added to the database through CRUD will not be here — that is the
  // point of the feature — but a tool added to THIS file and not to the seed
  // is a fallback that disagrees with the live list for no reason.
  const migration = await readFile(
    new URL("../../../apps/web/db/migrations/0031_platform_tools.sql", import.meta.url),
    "utf8",
  );
  for (const tool of INTERNAL_TOOLS) {
    expect(migration, `${tool.name} is in the fallback but not in the seed`).toContain(
      `'${tool.subdomain}'`,
    );
  }
});
```

Add `import { readFile } from "node:fs/promises";`. If console-core's Vitest
config runs in a browser-like environment where `node:fs` is unavailable, drop
this test and instead assert the count — `expect(INTERNAL_TOOLS).toHaveLength(15)`
— with a comment pointing at the migration. Do not leave a test that silently
passes by not running.

- [ ] **Step 2: Update the header comment in `tools.ts`**

The file's opening comment says the directory "needs no backend at all". That
is now false. Replace that clause with:

```
 * As of #318 this list is the FALLBACK, not the source of truth: the live
 * directory is `platform_tools` in tesserix_admin, served at
 * /v1/platform/tools and read by apps/console/lib/tools-directory.ts. This
 * literal is what renders when PLATFORM_API_ORIGIN is unset — which is
 * byte-for-byte the pre-#318 behaviour — and when the API cannot be reached,
 * in which case the page says so.
 *
 * Keep it in step with migration 0031's seed. A tool added through the API
 * will not appear here, and should not; a tool added HERE and not to the seed
 * is a fallback that disagrees with the live list for no reason.
```

Leave the "DELIBERATELY NO STATUS" paragraph exactly as it is — it is still
true, and the module doc in the Go package now repeats it.

- [ ] **Step 3: Run every suite**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
npx turbo run test --filter=@tesserix/console-core --filter=console
cd apps/console && npx next build && npx eslint . --max-warnings 0
cd ../../platform-api && go build ./... && go vet ./... && go test ./... 2>&1 | tail -20
```

Expected: all green. Confirm the Go run reports **zero skips**.

- [ ] **Step 4: Apply the migration to production BEFORE the PR merges**

```bash
export KUBECONFIG=~/.kube/gke-prod
kubectl -n tesserix port-forward svc/tesserix-postgres-rw 5433:5432 &
# credentials: secret tesserix-postgres-tesserix-admin, database tesserix_admin
psql "$DSN" -f apps/web/db/migrations/0031_platform_tools.sql
psql "$DSN" -c 'SELECT count(*) FROM platform_tools;'   # expect 15
psql "$DSN" -c 'SELECT count(*) FROM platform_tool_groups;'  # expect 5
```

Kargo deploys on merge and `db:migrate` does not ride along, so a merge before
this step gives the console a 500 on its home page. Verify the counts; do not
assume the file applied.

- [ ] **Step 5: Verify against the live system**

With the migration applied and the branch deployed, confirm by observation
rather than by reading the deploy log:

1. `GET https://api.tesserix.app/v1/platform/tools` with an operator token
   returns 15 tools.
2. The same request with a token holding only `read` returns 403.
3. The console home page renders every group, and does **not** show the
   "built-in list" line.
4. The command palette finds a tool added through `POST /v1/platform/tools`
   without a deploy.

- [ ] **Step 6: Commit and open the PR**

```bash
git add packages/console-core/src/tools.ts packages/console-core/src/tools.test.ts
git commit -m "test(console-core): assert the tools literal as a fallback, not a source of truth"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: schema and its two
property-carrying constraints → Task 1; the eight routes, capability, envelope,
`RejectUnknownParameters`, `RouteTable`/`routeCases` → Tasks 3–5; idempotency
and `write.Perform` → Tasks 4–5; no-pagination, argued in the module doc →
Task 3; the console dual path and labelled fallback → Tasks 6–7; the search
trap → Task 8; the weakened empty-group guarantee → Tasks 7 and 9; migration
applied before merge, and zero-skip verification → Task 9 and the global
constraints.

**Known soft spots, named rather than hidden.**

1. **Task 3 ships six 501 stubs that Tasks 4–5 replace.** The alternative — a
   `RouteTable` that grows in Task 4 — would make the capability test's
   fail-closed property arrive after the routes it guards. Stubs behind the
   gate are the lesser evil, but Task 4 and Task 5 must actually delete them;
   a stub that survives is a 501 in production.
2. **Four assumptions were checked against the code and three were wrong.**
   `httpx.Error`'s status field is `StatusCode`, not `Status`. There is no
   `@/lib/logger` in this app at all — the convention is a bare
   `console.warn("[console] ...", cause)`, as in `lib/db-read-error.ts:147`.
   `toolUrl` takes the nominal `InternalTool`, which a `DirectoryTool` does not
   satisfy, so the widening in Task 7 is mandatory rather than conditional. All
   three are corrected inline above. The fourth held: the audit table really is
   `console_audit_log (actor, action, target, occurred_at, metadata)`
   (`internal/platform/audit/audit.go:131`).
3. **`command-palette.render.test.tsx`'s props object is referred to as
   `baseProps`.** Task 8 Step 5 says to match whatever that file actually calls
   it; the name was not verified.
4. **console-core's Vitest environment** decides whether Task 9's
   seed-parity test can read the migration off disk. The task gives the
   fallback assertion and forbids leaving a test that passes by not running.
