package gitops

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// targetTrailer prefixes the line naming the apps a proposal covers. The title
// is prose and the branch name is ambiguous once a hyphen appears in either
// half, so the apps are stated once in a form that parses back.
const targetTrailer = "whitelist: "

// requesterTrailer prefixes the line naming the operator who asked for the
// change. The body already says "Requested by X" in prose for a human
// reviewer; that sentence is prose and has been reworded before, so the
// subject is stated a second time in a form the code owns — the same
// reasoning that put the apps behind targetTrailer.
const requesterTrailer = "requested-by: "

// PullRequest is one console-raised change awaiting review.
type PullRequest struct {
	Number    int       `json:"number"`
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	Branch    string    `json:"branch"`
	Author    string    `json:"author"`
	CreatedAt time.Time `json:"createdAt"`
	// RequestedBy is the Zitadel subject of the operator who raised this, read
	// back from the requested-by trailer. NOT Author, which is the login of
	// the token that opened the pull request and is therefore the same
	// identity for every proposal the console raises.
	RequestedBy string `json:"requestedBy"`
	// Targets are the namespace/app pairs this proposal whitelists.
	Targets []string `json:"targets"`
	// MergedAt is when GitHub merged this. It is the notification's timestamp,
	// not CreatedAt: a proposal that waited a week in the queue would
	// otherwise produce an event dated to when it was raised, arriving older
	// than the operator's read watermark and so pre-read.
	MergedAt time.Time `json:"mergedAt"`
}

// PullDetail adds what an administrator needs to decide: the diff, who has
// already approved, and whether GitHub would let it merge.
type PullDetail struct {
	PullRequest
	MergeableState string        `json:"mergeableState"`
	Approvals      []string      `json:"approvals"`
	Files          []ChangedFile `json:"files"`
}

type ChangedFile struct {
	Filename  string `json:"filename"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Patch     string `json:"patch"`
}

type pullResource struct {
	Number         int    `json:"number"`
	Title          string `json:"title"`
	HTMLURL        string `json:"html_url"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	MergeableState string `json:"mergeable_state"`
	User           struct {
		Login string `json:"login"`
	} `json:"user"`
	Head struct {
		Ref string `json:"ref"`
	} `json:"head"`
	Body string `json:"body"`
	// MergedAt is nullable: GitHub sends null for a closed-but-unmerged pull
	// request, and a zero time.Time after parsing cannot be told apart from a
	// parse failure. The merged filter tests this pointer, not a zero value.
	MergedAt *string `json:"merged_at"`
}

func (p pullResource) toPullRequest() PullRequest {
	created, _ := time.Parse(time.RFC3339, p.CreatedAt)
	return PullRequest{
		Number:      p.Number,
		Title:       p.Title,
		URL:         p.HTMLURL,
		Branch:      p.Head.Ref,
		Author:      p.User.Login,
		CreatedAt:   created,
		RequestedBy: trailerValue(p.Body, requesterTrailer),
		Targets:     parseTargets(p.Body),
	}
}

// trailerValue returns the text after the first line beginning with prefix,
// or "" when no such line exists. An absent trailer is a proposal opened
// before the trailer existed; "" is the only safe answer for both callers:
// the requester trailer treats it as "addressed to nobody", and
// parseTargets, its other caller, treats it as "no targets".
func trailerValue(body, prefix string) string {
	for line := range strings.SplitSeq(body, "\n") {
		if rest, found := strings.CutPrefix(strings.TrimSpace(line), prefix); found {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}

func parseTargets(body string) []string {
	rest := trailerValue(body, targetTrailer)
	if rest == "" {
		return nil
	}
	targets := make([]string, 0, 2)
	for target := range strings.SplitSeq(rest, ",") {
		if trimmed := strings.TrimSpace(target); trimmed != "" {
			targets = append(targets, trimmed)
		}
	}
	return targets
}

// pullPageSize is GitHub's maximum page; a smaller one only costs more requests.
const pullPageSize = 100

// maxPullPages bounds the walk so a repository in a pathological state cannot
// make the review screen page forever. A thousand simultaneously open pull
// requests on tesserix-k8s is not a review queue, it is an incident.
const maxPullPages = 10

// Pulls lists the open pull requests this console raised, newest first. Changes
// a human opened by hand are none of the console's business.
//
// The filtering is client-side — GitHub cannot query by branch prefix — so
// every open pull request has to be fetched, not just the first hundred. One
// unpaginated request silently dropped everything past page one: the operator
// saw a shorter list and no indication that it was short, which is the failure
// mode this walk exists to remove. Hitting the bound is reported as an error
// for the same reason; a quietly truncated list is worse than none.
func (g *GitHub) Pulls(ctx context.Context) ([]PullRequest, error) {
	out := make([]PullRequest, 0, pullPageSize)

	for page := 1; page <= maxPullPages; page++ {
		var batch []pullResource
		path := fmt.Sprintf("/repos/%s/%s/pulls?state=open&per_page=%d&page=%d&base=%s",
			g.cfg.Owner, g.cfg.Repo, pullPageSize, page, g.cfg.Branch)
		if err := g.do(ctx, http.MethodGet, path, nil, &batch); err != nil {
			return nil, err
		}

		for _, p := range batch {
			if strings.HasPrefix(p.Head.Ref, branchPrefix) {
				out = append(out, p.toPullRequest())
			}
		}

		// A short page is the last page; GitHub fills every page but the last.
		if len(batch) < pullPageSize {
			sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
			return out, nil
		}
	}

	return nil, fmt.Errorf("gitops: %s/%s has more than %d open pull requests; the review list would be truncated",
		g.cfg.Owner, g.cfg.Repo, maxPullPages*pullPageSize)
}

// maxMergedPullPages is a safety net against a misbehaving upstream, not the
// walk's real bound. `since` is what stops MergedPulls in the ordinary case:
// an operator polling the notification bell advances the read watermark on
// every visit, so the walk only ever needs to cross a handful of pages back
// into history before a page of closed pull requests updated before `since`
// ends it. This ceiling exists only so that an upstream which keeps
// answering full pages of recently-updated pull requests forever cannot turn
// a request the notification bell polls into an unbounded loop. Reaching it
// is reported as an error rather than the list collected so far, for the same
// reason Pulls' own ceiling is: a quietly truncated list is worse than none.
const maxMergedPullPages = 50

// MergedPulls lists console-raised proposals merged since the given time,
// newest first.
//
// The walk is bounded by `since` rather than by a page count, and that
// differs from Pulls deliberately. Pulls' maxPullPages describes a state that
// should never occur — a thousand simultaneously OPEN pull requests is an
// incident, not a review queue. Closed pull requests carry no such ceiling:
// they accumulate for the life of the repository, so a page bound here would
// silently begin missing recent merges as history grows. That is the same
// quietly-truncated-list failure Pulls' own comment exists to remove.
// maxMergedPullPages is a separate, much larger backstop against a
// misbehaving upstream; see its comment.
func (g *GitHub) MergedPulls(ctx context.Context, since time.Time) ([]PullRequest, error) {
	out := make([]PullRequest, 0, pullPageSize)

	for page := 1; page <= maxMergedPullPages; page++ {
		var batch []pullResource
		path := fmt.Sprintf("/repos/%s/%s/pulls?state=closed&per_page=%d&page=%d&base=%s&sort=updated&direction=desc",
			g.cfg.Owner, g.cfg.Repo, pullPageSize, page, g.cfg.Branch)
		if err := g.do(ctx, http.MethodGet, path, nil, &batch); err != nil {
			return nil, err
		}

		for _, p := range batch {
			updated, err := time.Parse(time.RFC3339, p.UpdatedAt)
			if err == nil && updated.Before(since) {
				sort.Slice(out, func(i, j int) bool { return out[i].MergedAt.After(out[j].MergedAt) })
				return out, nil
			}
			if p.MergedAt == nil || !strings.HasPrefix(p.Head.Ref, branchPrefix) {
				continue
			}
			merged, err := time.Parse(time.RFC3339, *p.MergedAt)
			if err != nil || merged.Before(since) {
				continue
			}
			pr := p.toPullRequest()
			pr.MergedAt = merged
			out = append(out, pr)
		}

		// A short page is the last page; GitHub fills every page but the last.
		if len(batch) < pullPageSize {
			sort.Slice(out, func(i, j int) bool { return out[i].MergedAt.After(out[j].MergedAt) })
			return out, nil
		}
	}

	return nil, fmt.Errorf("gitops: %s/%s has more than %d closed pull requests updated since %s; the merged list would be truncated",
		g.cfg.Owner, g.cfg.Repo, maxMergedPullPages*pullPageSize, since.Format(time.RFC3339))
}

func (g *GitHub) Pull(ctx context.Context, number int) (PullDetail, error) {
	var meta pullResource
	if err := g.do(ctx, http.MethodGet, g.pullPath(number), nil, &meta); err != nil {
		return PullDetail{}, err
	}

	// The files and reviews below are deliberately left unpaginated. Unlike the
	// list above, whose length is the size of the review queue and grows on its
	// own, a single proposal with more than a hundred changed files or a
	// hundred reviews is a different problem — one this console does not create,
	// since it commits two files — and paginating here would hide it rather
	// than fix it.
	var files []ChangedFile
	if err := g.do(ctx, http.MethodGet, g.pullPath(number)+"/files?per_page=100", nil, &files); err != nil {
		return PullDetail{}, err
	}

	var reviews []struct {
		State string `json:"state"`
		User  struct {
			Login string `json:"login"`
		} `json:"user"`
	}
	if err := g.do(ctx, http.MethodGet, g.pullPath(number)+"/reviews?per_page=100", nil, &reviews); err != nil {
		return PullDetail{}, err
	}

	approvals := make([]string, 0, len(reviews))
	for _, r := range reviews {
		if r.State == "APPROVED" {
			approvals = append(approvals, r.User.Login)
		}
	}

	return PullDetail{
		PullRequest:    meta.toPullRequest(),
		MergeableState: meta.MergeableState,
		Approvals:      approvals,
		Files:          files,
	}, nil
}

// Approve records an approving review. GitHub refuses it when the token that
// opened the pull request is the one approving, and that refusal is returned
// rather than swallowed.
func (g *GitHub) Approve(ctx context.Context, number int, actor string) error {
	body := map[string]any{
		"event": "APPROVE",
		"body":  fmt.Sprintf("Approved by %s in the secret-service console.", actor),
	}
	return g.do(ctx, http.MethodPost, g.pullPath(number)+"/reviews", body, nil)
}

// Merge squashes the change onto the default branch and returns the merge
// commit. ArgoCD picks it up from there.
func (g *GitHub) Merge(ctx context.Context, number int, actor string) (string, error) {
	var resp struct {
		Merged  bool   `json:"merged"`
		SHA     string `json:"sha"`
		Message string `json:"message"`
	}
	body := map[string]any{
		"merge_method":   "squash",
		"commit_title":   fmt.Sprintf("merge pull request #%d", number),
		"commit_message": fmt.Sprintf("Merged by %s in the secret-service console.", actor),
	}
	if err := g.do(ctx, http.MethodPut, g.pullPath(number)+"/merge", body, &resp); err != nil {
		return "", err
	}
	if !resp.Merged {
		return "", fmt.Errorf("gitops: pull request %d was not merged: %s", number, resp.Message)
	}
	return resp.SHA, nil
}

// Reject closes the proposal and deletes its branch so the same grant can be
// proposed again from the current default branch. The reason is left as a
// comment: a closed pull request with no explanation tells the requester nothing.
func (g *GitHub) Reject(ctx context.Context, number int, actor, reason string) error {
	var meta pullResource
	if err := g.do(ctx, http.MethodGet, g.pullPath(number), nil, &meta); err != nil {
		return err
	}
	if !strings.HasPrefix(meta.Head.Ref, branchPrefix) {
		return fmt.Errorf("gitops: pull request %d was not raised by this console", number)
	}

	if strings.TrimSpace(reason) == "" {
		reason = "no reason given"
	}
	comment := map[string]any{
		"body": fmt.Sprintf("Rejected by %s in the secret-service console: %s", actor, reason),
	}
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", g.cfg.Owner, g.cfg.Repo, number)
	if err := g.do(ctx, http.MethodPost, path, comment, nil); err != nil {
		return err
	}

	if err := g.do(ctx, http.MethodPatch, g.pullPath(number), map[string]any{"state": "closed"}, nil); err != nil {
		return err
	}

	ref := fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", g.cfg.Owner, g.cfg.Repo, meta.Head.Ref)
	return g.do(ctx, http.MethodDelete, ref, nil, nil)
}

func (g *GitHub) pullPath(number int) string {
	return fmt.Sprintf("/repos/%s/%s/pulls/%d", g.cfg.Owner, g.cfg.Repo, number)
}
