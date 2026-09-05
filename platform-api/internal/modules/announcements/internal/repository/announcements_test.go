package repository_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/repository"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb"
)

// The targeting is a JSONB containment query with two NULL branches, and the
// branches are the part worth pinning: `audience_filter->'products'` ABSENT
// means "every product", not "no product". Dropping either branch hides every
// untargeted broadcast — which is most of them — and the symptom is an empty
// banner rather than an error.

func seed(t *testing.T, pool *pgxpool.Pool, title, filter string, published bool, window string) {
	t.Helper()
	starts, ends := "now() - interval '1 hour'", "NULL"
	switch window {
	case "future":
		starts = "now() + interval '1 day'"
	case "ended":
		ends = "now() - interval '1 minute'"
	}
	_, err := pool.Exec(context.Background(),
		`INSERT INTO platform_announcements (title, body, severity, audience_filter, is_published, starts_at, ends_at)
		 VALUES ($1, 'body', 'info', $2::jsonb, $3, `+starts+`, `+ends+`)`,
		title, filter, published)
	if err != nil {
		t.Fatalf("seeding %q: %v", title, err)
	}
}

func activeTitles(t *testing.T, pool *pgxpool.Pool, product, status string) map[string]bool {
	t.Helper()
	got, err := repository.Active(context.Background(), pool, product, status)
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	seen := map[string]bool{}
	for _, a := range got {
		seen[a.Title] = true
	}
	return seen
}

func TestAnUntargetedAnnouncementReachesEveryProduct(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, "everyone", `{}`, true, "live")

	if !activeTitles(t, pool, "mark8ly", "active")["everyone"] {
		t.Error("an announcement with no product filter did not reach mark8ly — the NULL branch is what makes an untargeted broadcast universal")
	}
	if !activeTitles(t, pool, "kora", "active")["everyone"] {
		t.Error("the same announcement did not reach kora")
	}
}

func TestAProductTargetedAnnouncementReachesOnlyThatProduct(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, "mark8ly-only", `{"products":["mark8ly"]}`, true, "live")

	if !activeTitles(t, pool, "mark8ly", "active")["mark8ly-only"] {
		t.Error("a mark8ly-targeted announcement did not reach mark8ly")
	}
	if activeTitles(t, pool, "kora", "active")["mark8ly-only"] {
		t.Error("a mark8ly-targeted announcement reached kora")
	}
}

func TestStatusTargetingFiltersTheSameWay(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, "trialing-only", `{"statuses":["trialing"]}`, true, "live")

	if !activeTitles(t, pool, "mark8ly", "trialing")["trialing-only"] {
		t.Error("a trialing-targeted announcement did not reach a trialing tenant")
	}
	if activeTitles(t, pool, "mark8ly", "active")["trialing-only"] {
		t.Error("a trialing-targeted announcement reached an active tenant")
	}
}

func TestUnpublishedAndOutOfWindowAreNotServed(t *testing.T) {
	// Three ways an announcement is not live. A merchant seeing a draft, or a
	// maintenance notice for work that finished, is worse than seeing nothing.
	pool := testdb.New(t)
	seed(t, pool, "draft", `{}`, false, "live")
	seed(t, pool, "scheduled", `{}`, true, "future")
	seed(t, pool, "expired", `{}`, true, "ended")
	seed(t, pool, "live-one", `{}`, true, "live")

	got := activeTitles(t, pool, "mark8ly", "active")
	for _, hidden := range []string{"draft", "scheduled", "expired"} {
		if got[hidden] {
			t.Errorf("%q was served", hidden)
		}
	}
	if !got["live-one"] {
		t.Error("the live announcement was not served — the filters exclude too much")
	}
}

func TestAnEmptyResultIsAListAndNotNull(t *testing.T) {
	pool := testdb.New(t)
	seed(t, pool, "kora-only", `{"products":["kora"]}`, true, "live")

	got, err := repository.Active(context.Background(), pool, "mark8ly", "active")
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if got == nil {
		t.Error("an empty result was nil — it marshals as null, and a client expecting a list would be reading a bug in this API")
	}
	if len(got) != 0 {
		t.Errorf("got %d announcements, want none", len(got))
	}
}
