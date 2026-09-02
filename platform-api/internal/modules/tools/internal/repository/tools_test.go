package repository_test

import (
	"context"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/domain"
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
	if len(tools) != 14 {
		t.Fatalf("got %d tools, want the 14 in tools.ts: %+v", len(tools), tools)
	}
	if tools[0].Subdomain != "auth" || tools[0].Name != "Zitadel" {
		t.Errorf("first tool = %s/%s, want Zitadel/auth", tools[0].Name, tools[0].Subdomain)
	}
}

func TestTheOneToolWithANoteKeepsIt(t *testing.T) {
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
	// Exactly the one that carries one in tools.ts. A note is present only
	// where there is something real to say, and the seed must not invent any.
	//
	// This was two until 0042 deleted the secret-service row, which held the
	// other one: the standalone secrets UI it described is gone, so its
	// "separate login" note describes nothing. argocd is the survivor.
	if len(noted) != 1 {
		t.Errorf("got %d notes, want 1 (argocd): %+v", len(noted), noted)
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

func TestTheApiAndTheDatabaseRefuseTheSameSubdomains(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()

	// The regex is written twice — once in domain, once in migration 0031 —
	// and this is what keeps the copies honest. A divergence means either a
	// 500 from a constraint the API thought it had already checked, or a row
	// the API refuses that the database would have taken.
	for _, candidate := range []string{
		"a", "ab", "z9", "secret-service-2",
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
