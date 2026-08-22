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
