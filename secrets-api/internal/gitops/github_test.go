package gitops_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

type call struct {
	Method string
	Path   string
	// Query is kept because pagination lives entirely in the query string; a
	// recorder that drops it cannot tell one page from the same page twice.
	Query string
	Body  map[string]any
}

func stubGitHub(t *testing.T, handle func(*call) (int, any)) (*gitops.GitHub, *[]call) {
	t.Helper()
	var seen []call

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := call{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery}
		_ = json.NewDecoder(r.Body).Decode(&c.Body)
		seen = append(seen, c)

		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		status, body := handle(&c)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	client := gitops.NewGitHub(gitops.GitHubConfig{
		BaseURL:     srv.URL,
		Owner:       "tesserix",
		Repo:        "tesserix-k8s",
		Branch:      "main",
		Path:        "charts/thirdparty/openbao/values.yaml",
		ProjectPath: "argocd/prod/projects/security.yaml",
		Token:       "test-token",
	})
	return client, &seen
}

func defaultRoutes(t *testing.T) func(*call) (int, any) {
	t.Helper()
	return func(c *call) (int, any) {
		switch {
		case c.Method == http.MethodGet && strings.HasSuffix(c.Path, "values.yaml"):
			return http.StatusOK, map[string]any{
				"content":  base64.StdEncoding.EncodeToString([]byte(valuesYAML)),
				"sha":      "file-sha",
				"encoding": "base64",
			}
		case c.Method == http.MethodGet && strings.HasSuffix(c.Path, "security.yaml"):
			return http.StatusOK, map[string]any{
				"content":  base64.StdEncoding.EncodeToString([]byte(projectYAML)),
				"sha":      "project-sha",
				"encoding": "base64",
			}
		case strings.Contains(c.Path, "/git/ref/"):
			return http.StatusOK, map[string]any{"object": map[string]any{"sha": "base-sha"}}
		case strings.HasSuffix(c.Path, "/pulls"):
			return http.StatusCreated, map[string]any{"html_url": "https://github.com/tesserix/tesserix-k8s/pull/9"}
		default:
			return http.StatusCreated, map[string]any{}
		}
	}
}

// chartRoutes serves a chart alongside the whitelist, for the proposals that
// rewire an app rather than grant it.
func chartRoutes(t *testing.T) func(*call) (int, any) {
	t.Helper()
	base := defaultRoutes(t)
	return func(c *call) (int, any) {
		switch {
		case c.Method == http.MethodGet && strings.HasSuffix(c.Path, "cloudflared/values.yaml"):
			return http.StatusOK, map[string]any{"content": base64.StdEncoding.EncodeToString([]byte(chartValues)), "sha": "values-sha"}
		case c.Method == http.MethodGet && strings.HasSuffix(c.Path, "Chart.yaml"):
			chart := "apiVersion: v2\nname: cloudflared\nversion: 1.1.9\n"
			return http.StatusOK, map[string]any{"content": base64.StdEncoding.EncodeToString([]byte(chart)), "sha": "chart-sha"}
		default:
			return base(c)
		}
	}
}

func findCall(t *testing.T, seen []call, method, contains string) call {
	t.Helper()
	for _, c := range seen {
		if c.Method == method && strings.Contains(c.Path, contains) {
			return c
		}
	}
	t.Fatalf("no %s call containing %q; saw %+v", method, contains, seen)
	return call{}
}

func TestProposeOpensAPullRequestAgainstTheDefaultBranch(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	url, err := client.Propose(context.Background(), gitops.Change{
		Add:     &gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"},
		Actor:   "samyak.rout@gmail.com",
		Summary: "grant homechef-worker",
	})
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	if url != "https://github.com/tesserix/tesserix-k8s/pull/9" {
		t.Errorf("Propose returned %q, want the pull request URL", url)
	}

	pull := findCall(t, *seen, http.MethodPost, "/pulls")
	if pull.Body["base"] != "main" {
		t.Errorf("base = %v, want main", pull.Body["base"])
	}
	head, _ := pull.Body["head"].(string)
	if !strings.HasPrefix(head, "secret-service/") {
		t.Errorf("head = %q, want a secret-service/ branch", head)
	}
	// The console cannot merge, so the actor has to be legible to whoever does.
	if body, _ := pull.Body["body"].(string); !strings.Contains(body, "samyak.rout@gmail.com") {
		t.Errorf("pull request body %q does not name the requesting administrator", body)
	}
}

func TestProposeAllCarriesEveryAppInOnePullRequest(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	url, err := client.ProposeAll(context.Background(), []gitops.Change{
		{Add: &gitops.App{Namespace: "homechef", Name: "homechef-api", ServiceAccount: "homechef-api"}, Actor: "samyak.rout@gmail.com"},
		{Add: &gitops.App{Namespace: "homechef", Name: "homechef-web", ServiceAccount: "homechef-web"}, Actor: "samyak.rout@gmail.com"},
	})
	if err != nil {
		t.Fatalf("ProposeAll: %v", err)
	}
	if url != "https://github.com/tesserix/tesserix-k8s/pull/9" {
		t.Errorf("ProposeAll returned %q, want the pull request URL", url)
	}

	pulls := 0
	for _, c := range *seen {
		if c.Method == http.MethodPost && strings.HasSuffix(c.Path, "/pulls") {
			pulls++
		}
	}
	if pulls != 1 {
		t.Fatalf("opened %d pull requests, want one review for the whole change", pulls)
	}

	commit := findCall(t, *seen, http.MethodPut, "values.yaml")
	encoded, _ := commit.Body["content"].(string)
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("commit content is not base64: %v", err)
	}
	for _, app := range []string{"homechef-api", "homechef-web"} {
		if !strings.Contains(string(decoded), app) {
			t.Fatalf("committed values do not whitelist %s:\n%s", app, decoded)
		}
	}
}

func TestProposeAllRefusesAnEmptyChangeSet(t *testing.T) {
	client, _ := stubGitHub(t, defaultRoutes(t))
	if _, err := client.ProposeAll(context.Background(), nil); err == nil {
		t.Fatal("ProposeAll with no changes succeeded, want an error")
	}
}

func TestProposeCommitsTheEditedValuesOnItsOwnBranch(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	if _, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"},
		Actor: "samyak.rout@gmail.com",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	branch := findCall(t, *seen, http.MethodPost, "/git/refs")
	if branch.Body["sha"] != "base-sha" {
		t.Errorf("branch sha = %v, want the base branch head", branch.Body["sha"])
	}

	commit := findCall(t, *seen, http.MethodPut, "values.yaml")
	if commit.Body["sha"] != "file-sha" {
		t.Errorf("commit sha = %v, want the blob it is replacing", commit.Body["sha"])
	}
	if commit.Body["branch"] == "main" {
		t.Fatal("Propose committed straight to main")
	}

	encoded, _ := commit.Body["content"].(string)
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("commit content is not base64: %v", err)
	}
	if !strings.Contains(string(decoded), "homechef-worker") {
		t.Errorf("committed values do not contain the new app:\n%s", decoded)
	}
}

func TestProposeRemovesAnApp(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	if _, err := client.Propose(context.Background(), gitops.Change{
		Remove: &gitops.App{Namespace: "ai-database", Name: "qdrant"},
		Actor:  "samyak.rout@gmail.com",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	commit := findCall(t, *seen, http.MethodPut, "values.yaml")
	encoded, _ := commit.Body["content"].(string)
	decoded, _ := base64.StdEncoding.DecodeString(encoded)
	if strings.Contains(string(decoded), "qdrant") {
		t.Errorf("committed values still contain the removed app:\n%s", decoded)
	}
}

func TestProposeRequiresExactlyOneOperation(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	for name, change := range map[string]gitops.Change{
		"neither": {Actor: "samyak.rout@gmail.com"},
		"both": {
			Add:    &gitops.App{Namespace: "homechef", Name: "a", ServiceAccount: "a"},
			Remove: &gitops.App{Namespace: "homechef", Name: "b"},
			Actor:  "samyak.rout@gmail.com",
		},
	} {
		if _, err := client.Propose(context.Background(), change); err == nil {
			t.Errorf("Propose(%s) succeeded, want error", name)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("an invalid change still called GitHub: %+v", *seen)
	}
}

func TestProposeReportsAGitHubFailure(t *testing.T) {
	client, _ := stubGitHub(t, func(c *call) (int, any) {
		if strings.HasSuffix(c.Path, "/pulls") {
			return http.StatusUnprocessableEntity, map[string]any{"message": "no commits between branches"}
		}
		return defaultRoutes(t)(c)
	})

	_, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"},
		Actor: "samyak.rout@gmail.com",
	})
	if err == nil {
		t.Fatal("Propose succeeded despite GitHub rejecting the pull request")
	}
	if !strings.Contains(err.Error(), "no commits between branches") {
		t.Errorf("error = %v, want GitHub's own message", err)
	}
}

func TestProposeAllNamesItsAppsInAMachineReadableTrailer(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	_, err := client.ProposeAll(context.Background(), []gitops.Change{
		{Add: &gitops.App{Namespace: "dwellm8", Name: "dwellm8-api", ServiceAccount: "dwellm8-api"}, Actor: "sam@example.com"},
		{Add: &gitops.App{Namespace: "dwellm8", Name: "dwellm8-nats", ServiceAccount: "dwellm8-nats"}, Actor: "sam@example.com"},
	})
	if err != nil {
		t.Fatalf("ProposeAll: %v", err)
	}

	body, _ := findCall(t, *seen, http.MethodPost, "/pulls").Body["body"].(string)
	if !strings.Contains(body, "whitelist: dwellm8/dwellm8-api, dwellm8/dwellm8-nats") {
		t.Fatalf("pull request body has no whitelist trailer:\n%s", body)
	}
}

// A whitelist entry alone is not access: without the namespace in the
// AppProject, ArgoCD silently declines to create the SecretStore and still
// reports the app Synced. Both files have to move in the same review.
func TestProposeAlsoAddsTheNamespaceToTheAppProject(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	if _, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "cloudflared", Name: "cloudflared", ServiceAccount: "cloudflared"},
		Actor: "samyak.rout@gmail.com",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	commit := findCall(t, *seen, http.MethodPut, "security.yaml")
	if commit.Body["sha"] != "project-sha" {
		t.Errorf("commit sha = %v, want the AppProject blob it is replacing", commit.Body["sha"])
	}
	if commit.Body["branch"] == "main" {
		t.Fatal("Propose committed the AppProject straight to main")
	}

	decoded, err := base64.StdEncoding.DecodeString(commit.Body["content"].(string))
	if err != nil {
		t.Fatalf("commit content is not base64: %v", err)
	}
	if !strings.Contains(string(decoded), "namespace: cloudflared") {
		t.Errorf("committed AppProject has no destination for the namespace:\n%s", decoded)
	}
}

func TestProposeLeavesTheAppProjectAloneWhenTheNamespaceIsAlreadyListed(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	if _, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "homechef", Name: "homechef-worker", ServiceAccount: "homechef-worker"},
		Actor: "samyak.rout@gmail.com",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	for _, c := range *seen {
		if c.Method == http.MethodPut && strings.Contains(c.Path, "security.yaml") {
			t.Fatal("Propose committed an unchanged AppProject, adding an empty diff to the review")
		}
	}
}

// The destination goes with the namespace's last app, not with the first
// revocation: while another app is still whitelisted, dropping it would break
// that app instead.
func TestProposeDropsTheDestinationWithTheNamespacesLastApp(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	if _, err := client.Propose(context.Background(), gitops.Change{
		Remove: &gitops.App{Namespace: "homechef", Name: "homechef-api"},
		Actor:  "samyak.rout@gmail.com",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	commit := findCall(t, *seen, http.MethodPut, "security.yaml")
	decoded, _ := base64.StdEncoding.DecodeString(commit.Body["content"].(string))
	if strings.Contains(string(decoded), "namespace: homechef") {
		t.Errorf("committed AppProject still grants the emptied namespace:\n%s", decoded)
	}
	if !strings.Contains(string(decoded), "namespace: openbao") {
		t.Errorf("committed AppProject lost an unrelated destination:\n%s", decoded)
	}
}

// counts tallies the calls that leave something behind on GitHub. A no-op
// proposal has to make none of them: asserting only on the returned error would
// still pass while a branch was created and abandoned.
func counts(seen []call) (branches, commits, pulls int) {
	for _, c := range seen {
		switch {
		case c.Method == http.MethodPost && strings.Contains(c.Path, "/git/refs"):
			branches++
		case c.Method == http.MethodPut && strings.Contains(c.Path, "/contents/"):
			commits++
		case c.Method == http.MethodPost && strings.HasSuffix(c.Path, "/pulls"):
			pulls++
		}
	}
	return branches, commits, pulls
}

// AddApp is idempotent, so re-proposing an entry that is already whitelisted
// used to open a pull request on an empty diff — a mergeable near-neighbour of
// tesserix-k8s#392, which must never be merged.
func TestProposeRefusesAnAppThatIsAlreadyWhitelisted(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	url, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "homechef", Name: "homechef-api", ServiceAccount: "homechef-api"},
		Actor: "samyak.rout@gmail.com",
	})
	if !errors.Is(err, gitops.ErrNoChange) {
		t.Fatalf("Propose returned (%q, %v), want ErrNoChange", url, err)
	}
	if url != "" {
		t.Errorf("Propose returned the URL %q for a proposal it did not open", url)
	}

	branches, commits, pulls := counts(*seen)
	if branches != 0 || commits != 0 || pulls != 0 {
		t.Fatalf("a no-op proposal made %d branches, %d commits and %d pull requests, want none: %+v",
			branches, commits, pulls, *seen)
	}
}

// The revoke half reads worse still: an empty pull request titled "revoke"
// suggests access is being taken away when nothing is happening at all.
func TestProposeRefusesRemovingAnAppThatWasNeverWhitelisted(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	_, err := client.Propose(context.Background(), gitops.Change{
		Remove: &gitops.App{Namespace: "homechef", Name: "homechef-never-existed"},
		Actor:  "samyak.rout@gmail.com",
	})
	if !errors.Is(err, gitops.ErrNoChange) {
		t.Fatalf("Propose = %v, want ErrNoChange", err)
	}

	branches, commits, pulls := counts(*seen)
	if branches != 0 || commits != 0 || pulls != 0 {
		t.Fatalf("a no-op withdrawal made %d branches, %d commits and %d pull requests, want none: %+v",
			branches, commits, pulls, *seen)
	}
}

// An unchanged whitelist is not on its own a no-op: the AppProject moves in
// step with it and can be the half that needs the change. ai-database is
// whitelisted but has no destination, which is precisely the state that leaves
// ArgoCD reporting the app Synced while it renders nothing.
func TestProposeOpensAPullRequestWhenOnlyTheAppProjectChanges(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	url, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "ai-database", Name: "qdrant", ServiceAccount: "qdrant"},
		Actor: "samyak.rout@gmail.com",
	})
	if err != nil {
		t.Fatalf("Propose: %v", err)
	}
	if url != "https://github.com/tesserix/tesserix-k8s/pull/9" {
		t.Errorf("Propose returned %q, want the pull request URL", url)
	}

	commit := findCall(t, *seen, http.MethodPut, "security.yaml")
	decoded, _ := base64.StdEncoding.DecodeString(commit.Body["content"].(string))
	if !strings.Contains(string(decoded), "namespace: ai-database") {
		t.Errorf("committed AppProject has no destination for the namespace:\n%s", decoded)
	}

	for _, c := range *seen {
		if c.Method == http.MethodPut && strings.Contains(c.Path, "values.yaml") {
			t.Fatal("Propose committed an unchanged whitelist, widening the diff under review")
		}
	}
}

// One branch, both files, one review: a grant is a single decision even though
// it takes two files to describe.
func TestProposeCommitsBothFilesOnOneBranchInOnePullRequest(t *testing.T) {
	client, seen := stubGitHub(t, defaultRoutes(t))

	if _, err := client.Propose(context.Background(), gitops.Change{
		Add:   &gitops.App{Namespace: "cloudflared", Name: "cloudflared", ServiceAccount: "cloudflared"},
		Actor: "samyak.rout@gmail.com",
	}); err != nil {
		t.Fatalf("Propose: %v", err)
	}

	branches, commits, pulls := counts(*seen)
	if branches != 1 || commits != 2 || pulls != 1 {
		t.Fatalf("made %d branches, %d commits and %d pull requests, want 1, 2 and 1: %+v",
			branches, commits, pulls, *seen)
	}

	values := findCall(t, *seen, http.MethodPut, "values.yaml")
	project := findCall(t, *seen, http.MethodPut, "security.yaml")
	if values.Body["branch"] != project.Body["branch"] {
		t.Fatalf("the two files landed on different branches, %v and %v", values.Body["branch"], project.Body["branch"])
	}
}
