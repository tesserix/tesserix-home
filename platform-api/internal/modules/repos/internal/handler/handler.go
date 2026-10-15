// Package handler is the repos module's HTTP surface.
//
//	GET  /v1/repos              every repository in the org, with its signals
//	POST /v1/repos/visibility   {"repos": [...], "visibility": "private"}
//	                            {"repos": [...], "visibility": "public", "window_hours": 1..720}
//	                            {"repos": [...], "visibility": "public", "permanent": true}
//	POST /v1/repos/archive      {"repos": [...], "archived": true|false}
//
// # Capabilities
//
// Reading is `platform`. Writing is `platform` AND `repo-admin` — a verb on a
// surface, conventions §7 — because publishing a repository publishes its whole
// history, and nobody holding `platform` was granted that by holding it.
//
// # No Idempotency-Key
//
// Both writes set a target STATE rather than applying a delta, and report
// `changed: false` for a repository already in it. A retried request is
// therefore already harmless and already honest about what it did, which is
// what a stored-response replay would have bought.
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/repos/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// MaxRepos bounds one write. Above it is refused, not truncated: a batch that
// silently did the first N would leave the operator believing it did all.
const MaxRepos = 100

// maxBody caps a write's body: a hundred names is a few KiB.
const maxBody = 32 << 10

// repoName is GitHub's repository-name alphabet. Checked so a name cannot carry
// a path segment into the URL it is spliced into.
var repoName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths.
type Route struct {
	Method  string
	Pattern string
	// Verb is the capability a write needs beside `platform`; empty for reads.
	Verb    auth.Capability
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/repos",
		handler: func(h *Handler) http.HandlerFunc { return h.list }},
	{Method: http.MethodPost, Pattern: "/v1/repos/visibility", Verb: auth.CapRepoAdmin,
		handler: func(h *Handler) http.HandlerFunc { return h.visibility }},
	{Method: http.MethodPost, Pattern: "/v1/repos/archive", Verb: auth.CapRepoAdmin,
		handler: func(h *Handler) http.HandlerFunc { return h.archive }},
}

// Routes mounts the table behind its capability gates.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		var next http.Handler = r.handler(h)
		if r.Verb != "" {
			next = auth.RequireCapability(r.Verb, h.log, next)
		}
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log, auth.RequireCapability(auth.CapPlatform, h.log, next)))
	}
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), nil); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	listing, err := h.svc.List(r.Context())
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, listing, h.log)
}

type visibilityRequest struct {
	Repos       []string `json:"repos"`
	Visibility  string   `json:"visibility"`
	WindowHours *int     `json:"window_hours"`
	Permanent   bool     `json:"permanent"`
}

type archiveRequest struct {
	Repos    []string `json:"repos"`
	Archived *bool    `json:"archived"`
}

func (h *Handler) visibility(w http.ResponseWriter, r *http.Request) {
	var in visibilityRequest
	if !h.decode(w, r, &in) || !h.validRepos(w, r, in.Repos) {
		return
	}
	if in.Visibility != "public" && in.Visibility != "private" {
		httpx.WriteError(w, r, httpx.Validation("visibility must be public or private",
			map[string]any{"visibility": in.Visibility, "accepted": []string{"public", "private"}}), h.log)
		return
	}
	change := service.Change{Visibility: in.Visibility, Permanent: in.Permanent}
	switch {
	case in.Visibility == "private" && (in.WindowHours != nil || in.Permanent):
		httpx.WriteError(w, r, httpx.Validation("a private repository has no window and no permanence", nil), h.log)
		return
	case in.Visibility == "public" && (in.WindowHours == nil) == !in.Permanent:
		// Exactly one, and no default. A public repository with no recorded
		// reason is the state this surface exists to end, so the caller must
		// say which it means.
		httpx.WriteError(w, r, httpx.Validation(
			"making a repository public needs exactly one of window_hours or permanent", nil), h.log)
		return
	case in.WindowHours != nil:
		hours := *in.WindowHours
		maxHours := int(service.MaxWindow / time.Hour)
		if hours < 1 || hours > maxHours {
			httpx.WriteError(w, r, httpx.Validation(
				"window_hours must be between 1 and "+strconv.Itoa(maxHours)+"; longer than that, mark it permanent",
				map[string]any{"window_hours": hours}), h.log)
			return
		}
		change.Window = time.Duration(hours) * time.Hour
	}
	h.apply(w, r, in.Repos, change)
}

func (h *Handler) archive(w http.ResponseWriter, r *http.Request) {
	var in archiveRequest
	if !h.decode(w, r, &in) || !h.validRepos(w, r, in.Repos) {
		return
	}
	if in.Archived == nil {
		// Required rather than defaulted to true. A body that forgot the field
		// must not archive anything.
		httpx.WriteError(w, r, httpx.Validation("archived is required", nil), h.log)
		return
	}
	h.apply(w, r, in.Repos, service.Change{Archived: in.Archived})
}

func (h *Handler) apply(w http.ResponseWriter, r *http.Request, names []string, change service.Change) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}
	results, err := h.svc.Apply(r.Context(), principal.Subject, names, change)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, map[string]any{"results": results}, h.log)
}

// decode reads a write body strictly — conventions §4: an unknown field today
// is one this service might mean something by tomorrow.
func (h *Handler) decode(w http.ResponseWriter, r *http.Request, into any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("request body is not valid JSON for this endpoint"), h.log)
		return false
	}
	return true
}

func (h *Handler) validRepos(w http.ResponseWriter, r *http.Request, names []string) bool {
	if len(names) == 0 {
		httpx.WriteError(w, r, httpx.Validation("repos must name at least one repository", nil), h.log)
		return false
	}
	if len(names) > MaxRepos {
		httpx.WriteError(w, r, httpx.Validation(
			"repos names more than "+strconv.Itoa(MaxRepos)+" repositories", nil), h.log)
		return false
	}
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		if !repoName.MatchString(name) {
			httpx.WriteError(w, r, httpx.Validation("repos contains a name that is not a repository name",
				map[string]any{"repos": name}), h.log)
			return false
		}
		if seen[name] {
			httpx.WriteError(w, r, httpx.Validation("repos names a repository twice",
				map[string]any{"repos": name}), h.log)
			return false
		}
		seen[name] = true
	}
	return true
}

func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, service.ErrNotConfigured) {
		// 501, never 503: the console renders "not switched on" for it
		// rather than a red failure (conventions §1c).
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
		return
	}
	h.log.ErrorContext(r.Context(), "repos: request failed", "error", err)
	httpx.WriteError(w, r, httpx.Unavailable("GitHub could not be reached for the repository list"), h.log)
}
