package gitops

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultBaseURL = "https://api.github.com"

// branchPrefix marks the branches this console owns, and is how the review
// screen tells its own proposals from anyone else's work.
const branchPrefix = "secret-service/"

// ErrNoChange reports that a proposal would have carried an empty diff, so no
// branch, no commit and no pull request were made. It is not a failure: the
// desired state already holds, which from the operator's side is a success, and
// callers must answer it as one. It is a sentinel rather than an empty URL with
// a nil error because an empty string every caller has to remember to check is
// exactly the shape that let the empty proposals through in the first place.
var ErrNoChange = errors.New("gitops: the whitelist and the AppProject already match this change")

type GitHubConfig struct {
	BaseURL string
	Owner   string
	Repo    string
	Branch  string
	Path    string
	// ProjectPath is the AppProject whose destinations decide which namespaces
	// ArgoCD may render into. Left empty, that half of a grant is not proposed.
	ProjectPath string
	Token       string

	HTTPClient *http.Client
}

// GitHub proposes whitelist changes as pull requests. It holds no permission to
// merge: main is protected, so a grant still needs a second administrator.
type GitHub struct {
	cfg  GitHubConfig
	http *http.Client
}

func NewGitHub(cfg GitHubConfig) *GitHub {
	if cfg.BaseURL == "" {
		cfg.BaseURL = defaultBaseURL
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	return &GitHub{cfg: cfg, http: client}
}

// Change is one whitelist edit: exactly one of Add or Remove.
type Change struct {
	Add     *App
	Remove  *App
	Actor   string
	Summary string
}

func (c Change) app() *App {
	if c.Add != nil {
		return c.Add
	}
	return c.Remove
}

func (c Change) validate() error {
	if (c.Add == nil) == (c.Remove == nil) {
		return errors.New("gitops: a change must either add or remove exactly one app")
	}
	if strings.TrimSpace(c.Actor) == "" {
		return errors.New("gitops: a change must name the administrator requesting it")
	}
	return nil
}

// Propose branches from the default branch, commits the edited values.yaml, and
// opens a pull request. It returns the pull request's URL, or ErrNoChange when
// the change is already in place.
func (g *GitHub) Propose(ctx context.Context, change Change) (string, error) {
	return g.ProposeAll(ctx, []Change{change})
}

// ProposeAll carries several changes in a single branch and pull request, so a
// secret shared by many apps costs one review rather than one per app.
func (g *GitHub) ProposeAll(ctx context.Context, changes []Change) (string, error) {
	if len(changes) == 0 {
		return "", errors.New("gitops: nothing to propose")
	}
	for _, change := range changes {
		if err := change.validate(); err != nil {
			return "", err
		}
	}

	values, blobSHA, err := g.readFile(ctx, g.cfg.Path)
	if err != nil {
		return "", err
	}

	updated := values
	for _, change := range changes {
		if change.Add != nil {
			updated, err = AddApp(updated, *change.Add)
		} else {
			updated, err = RemoveApp(updated, change.Remove.Namespace, change.Remove.Name)
		}
		if err != nil {
			return "", err
		}
	}

	verb := "grant"
	if changes[0].Remove != nil {
		verb = "revoke"
	}
	app := changes[0].app()
	subject := fmt.Sprintf("%s/%s", app.Namespace, app.Name)
	if len(changes) > 1 {
		subject = fmt.Sprintf("%s and %d more", subject, len(changes)-1)
	}
	branch := fmt.Sprintf("%s%s-%s-%s-%d", branchPrefix, verb, app.Namespace, app.Name, time.Now().UTC().Unix())

	// The AppProject is read here rather than inside commitProject, where it
	// used to live, because whether this proposal has anything to review
	// depends on both files and that has to be settled before a branch exists.
	// commitProject only ever ran after createBranch, which is too late.
	project, err := g.planProject(ctx, changes, updated)
	if err != nil {
		return "", err
	}

	// AddApp and RemoveApp are idempotent, so without this a re-proposed entry
	// — or a withdrawal of one that was never there — created a branch,
	// committed an unchanged file and opened a pull request on an empty diff.
	// That is a safety problem, not untidiness: such a proposal's title is the
	// same shape as tesserix-k8s#392, a deliberate negative control that must
	// never be merged, because merging it would create the policy whose absence
	// produces the 403 that proves the grant is bounded. Manufacturing
	// mergeable, near-identical neighbours to a pull request that must not be
	// merged invites an administrator to merge the wrong one.
	//
	// Both halves have to be no-ops before there is nothing to review:
	// `updated == values` alone is not enough, because the AppProject moves in
	// step with the whitelist and can need a change when the whitelist does not.
	if updated == values && !project.changed() {
		return "", ErrNoChange
	}

	baseSHA, err := g.branchHead(ctx)
	if err != nil {
		return "", err
	}
	if err := g.createBranch(ctx, branch, baseSHA); err != nil {
		return "", err
	}

	title := fmt.Sprintf("chore(openbao): %s %s", verb, subject)
	// Reaching here with an unchanged whitelist means the AppProject is what
	// needs the change; committing the whitelist too would only widen the diff.
	if updated != values {
		if err := g.commit(ctx, branch, title, g.cfg.Path, updated, blobSHA); err != nil {
			return "", err
		}
	}
	if err := g.commitProject(ctx, branch, title, project); err != nil {
		return "", err
	}
	return g.pullRequest(ctx, branch, title, changes)
}

// projectUpdate is the AppProject half of a proposal, computed before any
// branch exists so that a proposal in which neither half changes can be refused
// without leaving a branch behind.
type projectUpdate struct {
	path    string
	before  string
	after   string
	blobSHA string
}

func (p projectUpdate) changed() bool {
	return p.path != "" && p.after != p.before
}

// planProject works out what the AppProject would become, without writing
// anything. A whitelist entry on its own is not access: ArgoCD declines to
// render into a namespace the project does not list, and reports the app Synced
// while it does. values is the whitelist as this proposal would leave it, which
// is what decides whether a namespace still has apps in it.
func (g *GitHub) planProject(ctx context.Context, changes []Change, values string) (projectUpdate, error) {
	if g.cfg.ProjectPath == "" {
		return projectUpdate{}, nil
	}

	project, blobSHA, err := g.readFile(ctx, g.cfg.ProjectPath)
	if err != nil {
		return projectUpdate{}, err
	}

	updated := project
	for _, change := range changes {
		namespace := change.app().Namespace
		// A namespace keeps its destination until its last app goes, or the
		// revocation would cut off the apps still whitelisted in it.
		if change.Add != nil {
			updated, err = AddDestination(updated, namespace)
		} else if !HasNamespace(values, namespace) {
			updated, err = RemoveDestination(updated, namespace)
		}
		if err != nil {
			return projectUpdate{}, err
		}
	}

	return projectUpdate{path: g.cfg.ProjectPath, before: project, after: updated, blobSHA: blobSHA}, nil
}

// commitProject moves the AppProject destinations in step with the whitelist.
func (g *GitHub) commitProject(ctx context.Context, branch, title string, project projectUpdate) error {
	// An unchanged file still commits, and the review would open on an empty
	// diff. ProposeAll refuses a proposal in which nothing changes at all, so
	// this now only catches the case where the whitelist moved and the project
	// did not — but it is kept as well as, not instead of, that refusal:
	// defence in depth against an empty diff costs nothing here.
	if !project.changed() {
		return nil
	}
	return g.commit(ctx, branch, title, project.path, project.after, project.blobSHA)
}

// ProposeWiring opens the pull request that moves one chart's ExternalSecret
// onto OpenBao: the values change and the chart version bump ArgoCD needs to
// pick it up, on one branch and one review.
func (g *GitHub) ProposeWiring(ctx context.Context, req WiringRequest) (string, error) {
	if err := req.validate(); err != nil {
		return "", err
	}

	valuesPath := req.ChartPath + "/" + req.ValuesFile
	values, valuesSHA, err := g.readFile(ctx, valuesPath)
	if err != nil {
		return "", err
	}
	rewired, err := Rewire(values, req.Wiring)
	if err != nil {
		return "", err
	}

	chartPath := req.ChartPath + "/Chart.yaml"
	chart, chartSHA, err := g.readFile(ctx, chartPath)
	if err != nil {
		return "", err
	}
	bumped, err := BumpChartVersion(chart)
	if err != nil {
		return "", err
	}

	title := fmt.Sprintf("chore(%s): read the secret from OpenBao", req.App)
	branch := fmt.Sprintf("%srewire-%s-%s-%d", branchPrefix, req.Namespace, req.App, time.Now().UTC().Unix())

	baseSHA, err := g.branchHead(ctx)
	if err != nil {
		return "", err
	}
	if err := g.createBranch(ctx, branch, baseSHA); err != nil {
		return "", err
	}
	if err := g.commit(ctx, branch, title, valuesPath, rewired, valuesSHA); err != nil {
		return "", err
	}
	if err := g.commit(ctx, branch, title, chartPath, bumped, chartSHA); err != nil {
		return "", err
	}

	summary := req.Summary
	if summary == "" {
		summary = fmt.Sprintf("%s reads %s from its own OpenBao store rather than Secret Manager.", req.App, req.RemoteKey)
	}
	body := fmt.Sprintf(
		"%s\n\nRequested by %s in the secret-service console.\n\nThe app must already be whitelisted in the openbao chart, or External Secrets has no store to read from.\n\n%s%s\n%s%s/%s",
		summary, req.Actor, requesterTrailer, req.Actor, targetTrailer, req.Namespace, req.App,
	)

	var resp struct {
		HTMLURL string `json:"html_url"`
	}
	err = g.do(ctx, http.MethodPost, fmt.Sprintf("/repos/%s/%s/pulls", g.cfg.Owner, g.cfg.Repo), map[string]any{
		"title": title,
		"head":  branch,
		"base":  g.cfg.Branch,
		"body":  body,
	}, &resp)
	if err != nil {
		return "", err
	}
	return resp.HTMLURL, nil
}

func (g *GitHub) readFile(ctx context.Context, file string) (contents, sha string, err error) {
	var body struct {
		Content string `json:"content"`
		SHA     string `json:"sha"`
	}
	path := fmt.Sprintf("/repos/%s/%s/contents/%s?ref=%s", g.cfg.Owner, g.cfg.Repo, file, url.QueryEscape(g.cfg.Branch))
	if err := g.do(ctx, http.MethodGet, path, nil, &body); err != nil {
		return "", "", err
	}

	// GitHub wraps base64 at 60 columns; the standard decoder rejects newlines.
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(body.Content, "\n", ""))
	if err != nil {
		return "", "", fmt.Errorf("gitops: decode %s: %w", file, err)
	}
	return string(decoded), body.SHA, nil
}

func (g *GitHub) branchHead(ctx context.Context) (string, error) {
	var body struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	path := fmt.Sprintf("/repos/%s/%s/git/ref/heads/%s", g.cfg.Owner, g.cfg.Repo, g.cfg.Branch)
	if err := g.do(ctx, http.MethodGet, path, nil, &body); err != nil {
		return "", err
	}
	return body.Object.SHA, nil
}

func (g *GitHub) createBranch(ctx context.Context, branch, sha string) error {
	return g.do(ctx, http.MethodPost, fmt.Sprintf("/repos/%s/%s/git/refs", g.cfg.Owner, g.cfg.Repo), map[string]any{
		"ref": "refs/heads/" + branch,
		"sha": sha,
	}, nil)
}

func (g *GitHub) commit(ctx context.Context, branch, message, file, contents, blobSHA string) error {
	path := fmt.Sprintf("/repos/%s/%s/contents/%s", g.cfg.Owner, g.cfg.Repo, file)
	return g.do(ctx, http.MethodPut, path, map[string]any{
		"message": message,
		"content": base64.StdEncoding.EncodeToString([]byte(contents)),
		"sha":     blobSHA,
		"branch":  branch,
	}, nil)
}

func (g *GitHub) pullRequest(ctx context.Context, branch, title string, changes []Change) (string, error) {
	summary := changes[0].Summary
	if summary == "" {
		summary = title
	}
	targets := make([]string, 0, len(changes))
	for _, change := range changes {
		app := change.app()
		targets = append(targets, app.Namespace+"/"+app.Name)
	}

	body := fmt.Sprintf(
		"%s\n\nRequested by %s in the secret-service console.\n\nMerging this lets External Secrets reach OpenBao for the app named above. It grants no ability to read any secret value through the console.\n\n%s%s\n%s%s",
		summary, changes[0].Actor, requesterTrailer, changes[0].Actor, targetTrailer, strings.Join(targets, ", "),
	)

	var resp struct {
		HTMLURL string `json:"html_url"`
	}
	err := g.do(ctx, http.MethodPost, fmt.Sprintf("/repos/%s/%s/pulls", g.cfg.Owner, g.cfg.Repo), map[string]any{
		"title": title,
		"head":  branch,
		"base":  g.cfg.Branch,
		"body":  body,
	}, &resp)
	if err != nil {
		return "", err
	}
	return resp.HTMLURL, nil
}

func (g *GitHub) do(ctx context.Context, method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, g.cfg.BaseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.cfg.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := g.http.Do(req)
	if err != nil {
		return fmt.Errorf("gitops: %s %s: %w", method, path, err)
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		var failure struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(res.Body).Decode(&failure)
		if failure.Message == "" {
			failure.Message = res.Status
		}
		return fmt.Errorf("gitops: %s %s: %s", method, path, failure.Message)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}
