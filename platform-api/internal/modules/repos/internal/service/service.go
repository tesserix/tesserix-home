// Package service composes the organisation's repositories with their security
// signals, and changes their visibility and archived state.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos/internal/github"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/audit"
)

// ErrNotConfigured is the answer when no GitHub App is configured. The handler
// turns it into a 501: an unconfigured surface must not impersonate an org
// with no repositories.
var ErrNotConfigured = errors.New("repos: no GitHub App is configured")

// perRepoConcurrency bounds the per-repository reads. Two calls a repository
// and ~70 repositories; eight at a time keeps a page load to a few seconds
// without GitHub's secondary rate limit noticing.
const perRepoConcurrency = 8

// Severities is the Dependabot severity vocabulary, in display order.
var Severities = []string{"critical", "high", "medium", "low"}

// Repo is one repository as the console shows it.
//
// Every security signal is a POINTER, and null means "not measured" — never
// zero. A private repository on GitHub Free has no secret scanning at all, and
// a repository with Dependabot switched off has no alerts because nothing is
// looking. Rendering either as "0" would tell an operator the repository is
// clean when the truth is that nobody checked.
type Repo struct {
	Name          string     `json:"name"`
	URL           string     `json:"url"`
	Description   string     `json:"description"`
	Visibility    string     `json:"visibility"`
	Archived      bool       `json:"archived"`
	Fork          bool       `json:"fork"`
	DefaultBranch string     `json:"default_branch"`
	Language      string     `json:"language"`
	PushedAt      *time.Time `json:"pushed_at"`
	Stars         int        `json:"stars"`

	BranchProtected      *bool          `json:"branch_protected"`
	DependabotEnabled    *bool          `json:"dependabot_enabled"`
	DependabotAlerts     map[string]int `json:"dependabot_alerts"`
	SecretScanningAlerts *int           `json:"secret_scanning_alerts"`

	// PublicPolicy is why a PUBLIC repository is public: a window that closes
	// on its own, or a decision that it stays. Null on a public repository
	// means nobody has decided, which the console flags. Always null on a
	// private one.
	PublicPolicy *Policy `json:"public_policy"`
}

// Policy is a public repository's recorded reason for being public.
type Policy struct {
	// Kind is "temporary" or "permanent".
	Kind string `json:"kind"`
	// RevertAt is when a temporary window closes. Nil for permanent.
	RevertAt *time.Time `json:"revert_at"`
}

// Gap is a signal that could not be read for the whole org. Reported beside
// the rows rather than logged, so a column of dashes says why.
type Gap struct {
	Signal  string `json:"signal"`
	Message string `json:"message"`
}

// Listing is the org's repositories.
type Listing struct {
	Org   string `json:"org"`
	Repos []Repo `json:"repos"`
	Gaps  []Gap  `json:"gaps"`
}

// Beginner opens the transaction an audit row is written on.
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service reads and changes the org's repositories.
type Service struct {
	gh  *github.Client
	db  Beginner
	log *slog.Logger
}

// New builds the service. gh is nil when no App is configured.
func New(gh *github.Client, db Beginner, log *slog.Logger) *Service {
	return &Service{gh: gh, db: db, log: log}
}

// List reads every repository and its signals.
//
// The repository list is the only read that fails the whole call. Everything
// else degrades: an org-level alert read that fails becomes a Gap and a null
// column, and a per-repository read that fails leaves that one cell null.
func (s *Service) List(ctx context.Context) (Listing, error) {
	if s.gh == nil {
		return Listing{}, ErrNotConfigured
	}
	repos, err := s.gh.Repos(ctx)
	if err != nil {
		return Listing{}, fmt.Errorf("repos: listing the org's repositories: %w", err)
	}

	out := Listing{Org: s.gh.Org(), Repos: make([]Repo, len(repos)), Gaps: []Gap{}}
	for i, r := range repos {
		out.Repos[i] = Repo{
			Name: r.Name, URL: r.HTMLURL, Description: deref(r.Description),
			Visibility: r.Visibility, Archived: r.Archived, Fork: r.Fork,
			DefaultBranch: r.DefaultBranch, Language: deref(r.Language),
			PushedAt: r.PushedAt, Stars: r.Stars,
		}
	}

	var (
		wg                sync.WaitGroup
		dependabot, scans []github.Alert
		dependabotErr     error
		scansErr          error
	)
	wg.Add(2)
	go func() { defer wg.Done(); dependabot, dependabotErr = s.gh.DependabotAlerts(ctx) }()
	go func() { defer wg.Done(); scans, scansErr = s.gh.SecretScanningAlerts(ctx) }()
	s.readPerRepo(ctx, out.Repos)
	wg.Wait()

	if dependabotErr != nil {
		s.log.ErrorContext(ctx, "repos: reading dependabot alerts", "error", dependabotErr)
		out.Gaps = append(out.Gaps, Gap{Signal: "dependabot_alerts", Message: gapMessage(dependabotErr)})
	} else {
		counts := map[string]map[string]int{}
		for _, a := range dependabot {
			if a.SecurityAdvisory == nil {
				continue
			}
			if counts[a.Repository.Name] == nil {
				counts[a.Repository.Name] = map[string]int{}
			}
			counts[a.Repository.Name][a.SecurityAdvisory.Severity]++
		}
		for i := range out.Repos {
			r := &out.Repos[i]
			// Counts only where Dependabot is known to be on. Off means
			// nothing is looking; unknown means we could not ask.
			if r.DependabotEnabled == nil || !*r.DependabotEnabled {
				continue
			}
			r.DependabotAlerts = map[string]int{}
			for _, sev := range Severities {
				r.DependabotAlerts[sev] = counts[r.Name][sev]
			}
		}
	}

	if scansErr != nil {
		s.log.ErrorContext(ctx, "repos: reading secret scanning alerts", "error", scansErr)
		out.Gaps = append(out.Gaps, Gap{Signal: "secret_scanning_alerts", Message: gapMessage(scansErr)})
	} else {
		counts := map[string]int{}
		for _, a := range scans {
			counts[a.Repository.Name]++
		}
		for i := range out.Repos {
			r := &out.Repos[i]
			// Public only: GitHub Free scans public repositories and nothing
			// else, so a private repository's zero would be a false all-clear.
			if r.Visibility != "public" {
				continue
			}
			n := counts[r.Name]
			r.SecretScanningAlerts = &n
		}
	}

	if err := s.attachPolicies(ctx, out.Repos); err != nil {
		s.log.ErrorContext(ctx, "repos: reading visibility policies", "error", err)
		out.Gaps = append(out.Gaps, Gap{Signal: "public_policy", Message: "the recorded public windows could not be read"})
	}

	sort.Slice(out.Repos, func(i, j int) bool { return out.Repos[i].Name < out.Repos[j].Name })
	return out, nil
}

// attachPolicies reads every recorded policy for the org onto its public
// repositories. A row for a repository that is no longer public is ignored:
// it describes nothing true, and the sweeper or the next change removes it.
func (s *Service) attachPolicies(ctx context.Context, repos []Repo) error {
	if s.db == nil {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx,
		`SELECT repo, policy, revert_at FROM repo_visibility_policies WHERE org = $1`, s.gh.Org())
	if err != nil {
		return err
	}
	defer rows.Close()
	policies := map[string]*Policy{}
	for rows.Next() {
		var name string
		var p Policy
		if err := rows.Scan(&name, &p.Kind, &p.RevertAt); err != nil {
			return err
		}
		policies[name] = &p
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range repos {
		if repos[i].Visibility == "public" {
			repos[i].PublicPolicy = policies[repos[i].Name]
		}
	}
	return nil
}

// readPerRepo fills branch protection and the Dependabot switch, which GitHub
// only answers one repository at a time.
func (s *Service) readPerRepo(ctx context.Context, repos []Repo) {
	sem := make(chan struct{}, perRepoConcurrency)
	var wg sync.WaitGroup
	for i := range repos {
		wg.Add(1)
		sem <- struct{}{}
		go func(r *Repo) {
			defer wg.Done()
			defer func() { <-sem }()
			if r.DefaultBranch != "" {
				if protected, err := s.gh.BranchProtected(ctx, r.Name, r.DefaultBranch); err == nil {
					r.BranchProtected = &protected
				} else if status, _ := github.StatusOf(err); status != http.StatusNotFound {
					// 404 is an empty repository, whose default branch does not
					// exist yet. Anything else is worth a line.
					s.log.WarnContext(ctx, "repos: reading branch protection", "repo", r.Name, "error", err)
				}
			}
			if enabled, err := s.gh.DependabotEnabled(ctx, r.Name); err == nil {
				r.DependabotEnabled = &enabled
			} else {
				s.log.WarnContext(ctx, "repos: reading the dependabot switch", "repo", r.Name, "error", err)
			}
		}(&repos[i])
	}
	wg.Wait()
}

// gapMessage explains an org-level read failure. GitHub's 403 here almost
// always means the App lacks the permission, which is the operator's next
// step, so it is said plainly.
func gapMessage(err error) string {
	if status, ok := github.StatusOf(err); ok && (status == http.StatusForbidden || status == http.StatusNotFound) {
		return "the GitHub App cannot read this — check it has the permission and the feature is enabled for the org"
	}
	return "GitHub could not be reached for this"
}

// MaxWindow is the longest a repository may be public on a timer. Longer
// than that is a decision, and should be recorded as one: permanent.
const MaxWindow = 30 * 24 * time.Hour

// Change is one requested change to a set of repositories.
type Change struct {
	// Exactly one of the two is set; the handler guarantees it.
	Visibility string
	Archived   *bool
	// For Visibility "public", exactly one of these; the handler guarantees
	// that too. Window is how long until the sweeper makes it private again.
	Window    time.Duration
	Permanent bool
}

// policy is the row a public change records, with its audit summary.
func (c Change) policy() (kind string, summary map[string]int) {
	if c.Permanent {
		return "permanent", map[string]int{"permanent": 1}
	}
	return "temporary", map[string]int{"window_hours": int(c.Window / time.Hour)}
}

// action is the audit action for the change. Distinct acts get distinct
// actions (conventions §6), so publishing and hiding are not one "visibility"
// row a reader must decode.
func (c Change) action() string {
	if c.Archived != nil {
		if *c.Archived {
			return "repos.archive"
		}
		return "repos.unarchive"
	}
	return "repos.visibility." + c.Visibility
}

func (c Change) patch() map[string]any {
	if c.Archived != nil {
		return map[string]any{"archived": *c.Archived}
	}
	return map[string]any{"visibility": c.Visibility}
}

// satisfiedBy reports whether a repository is already in the requested state.
func (c Change) satisfiedBy(r github.Repo) bool {
	if c.Archived != nil {
		return r.Archived == *c.Archived
	}
	return r.Visibility == c.Visibility
}

// Result is what happened to one repository.
type Result struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
	// Changed is false for a repository already in the requested state, which
	// is a success: the retry of a half-finished batch must not read as a
	// failure for the half that landed.
	Changed    bool   `json:"changed"`
	Visibility string `json:"visibility,omitempty"`
	Archived   bool   `json:"archived"`
	// Error is a closed code: not_found, archived, refused, unavailable.
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

// Apply changes each repository in turn and reports each outcome.
//
// GitHub has no bulk endpoint, so a batch can half-succeed, and the only
// honest shape for that is a result per repository. Sequential rather than
// concurrent: these are rare, deliberate writes, and an operator reading the
// results wants them in the order they asked.
func (s *Service) Apply(ctx context.Context, actor string, names []string, change Change) ([]Result, error) {
	if s.gh == nil {
		return nil, ErrNotConfigured
	}
	results := make([]Result, 0, len(names))
	for _, name := range names {
		results = append(results, s.applyOne(ctx, actor, name, change))
	}
	return results, nil
}

// applyOne makes one change, with its audit row.
//
// The audit row is written FIRST, on a transaction that commits only once
// GitHub has accepted the change. GitHub cannot join a transaction, so this is
// the nearest ordering to conventions §6: an audit row that cannot be written
// stops the change before it is made, and a change GitHub refuses rolls its
// row back. The one window left — GitHub accepted, then the commit failed — is
// logged at ERROR with everything needed to write the row by hand.
//
// A public change ALSO records its policy on that transaction, and does so
// even for a repository that is already public: that is how a window is
// extended, or an existing public repository is marked permanent.
func (s *Service) applyOne(ctx context.Context, actor, name string, change Change) Result {
	current, err := s.gh.Repo(ctx, name)
	if err != nil {
		return s.failure(ctx, name, change, err)
	}
	result := Result{Name: current.Name, OK: true, Visibility: current.Visibility, Archived: current.Archived}
	toGitHub := !change.satisfiedBy(current)
	recordsPolicy := change.Visibility == "public"
	if !toGitHub && !recordsPolicy {
		return result
	}
	if toGitHub && change.Archived == nil && current.Archived {
		// GitHub would refuse this with a 403 that reads like a permissions
		// problem. Saying what is actually wrong is cheaper than decoding it.
		return Result{Name: name, Error: "archived", Visibility: current.Visibility, Archived: true,
			Message: "archived repositories are read-only; unarchive it first"}
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		s.log.ErrorContext(ctx, "repos: opening the audit transaction", "repo", name, "error", err)
		return unrecorded(name)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	entry := audit.Entry{Actor: actor, Action: change.action(), Target: s.gh.Org() + "/" + current.Name}
	if !toGitHub {
		// Already public: only the policy moves, and that is its own act.
		entry.Action = "repos.public_policy.set"
	}
	switch {
	case recordsPolicy:
		kind, summary := change.policy()
		entry.Summary = summary
		var revertAt *time.Time
		if kind == "temporary" {
			at := time.Now().Add(change.Window)
			revertAt = &at
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO repo_visibility_policies (org, repo, policy, revert_at, set_by)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (org, repo) DO UPDATE
			SET policy = EXCLUDED.policy, revert_at = EXCLUDED.revert_at,
			    set_by = EXCLUDED.set_by, set_at = now()`,
			s.gh.Org(), current.Name, kind, revertAt, actor)
	case change.Visibility == "private":
		// Whatever it was public for, it no longer is.
		_, err = tx.Exec(ctx, `DELETE FROM repo_visibility_policies WHERE org = $1 AND repo = $2`,
			s.gh.Org(), current.Name)
	}
	if err == nil {
		err = audit.Write(ctx, tx, entry)
	}
	if err != nil {
		s.log.ErrorContext(ctx, "repos: recording the change", "repo", name, "error", err)
		return unrecorded(name)
	}

	if toGitHub {
		updated, err := s.gh.UpdateRepo(ctx, current.Name, change.patch())
		if err != nil {
			return s.failure(ctx, name, change, err)
		}
		result.Visibility, result.Archived = updated.Visibility, updated.Archived
	}
	if err := tx.Commit(ctx); err != nil {
		s.log.ErrorContext(ctx, "repos: a change whose record did not commit",
			"actor", actor, "action", entry.Action, "repo", current.Name, "applied_to_github", toGitHub, "error", err)
	}
	result.Changed = true
	return result
}

func unrecorded(name string) Result {
	return Result{Name: name, Error: "unavailable", Message: "the change could not be recorded, so it was not made"}
}

// SweeperActor attributes the sweeper's audit rows. Not a Zitadel subject, and
// deliberately unlike one, so a reader can tell a closed window from an
// operator's act at a glance.
const SweeperActor = "system:repos-window-sweeper"

// sweepBatch bounds one sweep. The rest wait a tick rather than holding row
// locks across a long run of GitHub calls.
const sweepBatch = 20

// ExpireDue makes every repository whose public window has closed private
// again, and reports how many it changed.
//
// One transaction per repository, holding that row FOR UPDATE SKIP LOCKED
// across the GitHub call: two replicas sweeping at once each take different
// rows, and a repository is never reverted twice. A GitHub failure rolls its
// row back and it is retried on the next sweep — the window stays recorded as
// closed until the repository actually is.
func (s *Service) ExpireDue(ctx context.Context, now time.Time) (int, error) {
	if s.gh == nil || s.db == nil {
		return 0, nil
	}
	changed := 0
	for range sweepBatch {
		done, flipped, err := s.expireOne(ctx, now)
		if err != nil {
			return changed, err
		}
		if flipped {
			changed++
		}
		if done {
			break
		}
	}
	return changed, nil
}

// expireOne handles the oldest due window, if there is one.
func (s *Service) expireOne(ctx context.Context, now time.Time) (done, flipped bool, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return true, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var name string
	err = tx.QueryRow(ctx, `
		SELECT repo FROM repo_visibility_policies
		WHERE org = $1 AND policy = 'temporary' AND revert_at <= $2
		ORDER BY revert_at
		LIMIT 1
		FOR UPDATE SKIP LOCKED`, s.gh.Org(), now).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, false, nil
	}
	if err != nil {
		return true, false, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM repo_visibility_policies WHERE org = $1 AND repo = $2`,
		s.gh.Org(), name); err != nil {
		return true, false, err
	}

	current, err := s.gh.Repo(ctx, name)
	if status, _ := github.StatusOf(err); status == http.StatusNotFound {
		// Deleted or renamed: there is nothing left to make private.
		return false, false, tx.Commit(ctx)
	}
	if err != nil {
		s.log.ErrorContext(ctx, "repos: reading a repository whose window closed", "repo", name, "error", err)
		return true, false, nil
	}
	if current.Visibility != "public" {
		// Someone made it private already. The row was the only thing left.
		return false, false, tx.Commit(ctx)
	}

	if err := audit.Write(ctx, tx, audit.Entry{
		Actor: SweeperActor, Action: "repos.visibility.private", Target: s.gh.Org() + "/" + name,
		Summary: map[string]int{"window_expired": 1},
	}); err != nil {
		return true, false, err
	}
	if _, err := s.gh.UpdateRepo(ctx, name, map[string]any{"visibility": "private"}); err != nil {
		// Stop this sweep rather than skipping ahead: the next row is very
		// likely to fail for the same reason, and the row stays due.
		s.log.ErrorContext(ctx, "repos: closing a public window", "repo", name, "error", err)
		return true, false, nil
	}
	if err := tx.Commit(ctx); err != nil {
		s.log.ErrorContext(ctx, "repos: GitHub closed a window whose record did not commit", "repo", name, "error", err)
		return true, true, nil
	}
	s.log.InfoContext(ctx, "repos: public window closed", "repo", name)
	return false, true, nil
}

// failure maps a GitHub refusal onto a per-repository result.
func (s *Service) failure(ctx context.Context, name string, change Change, err error) Result {
	s.log.ErrorContext(ctx, "repos: change failed", "repo", name, "action", change.action(), "error", err)
	status, ok := github.StatusOf(err)
	switch {
	case ok && status == http.StatusNotFound:
		return Result{Name: name, Error: "not_found", Message: "no such repository in the org, or the App cannot see it"}
	case ok && status < 500:
		var gh *github.StatusError
		errors.As(err, &gh)
		return Result{Name: name, Error: "refused", Message: "GitHub refused: " + gh.Message}
	default:
		// Deliberately not "nothing changed": a timeout after GitHub applied
		// the change is indistinguishable from one before.
		return Result{Name: name, Error: "unavailable", Message: "GitHub could not be reached; reload to see the repository's current state"}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
