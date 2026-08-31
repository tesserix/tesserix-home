package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

// Proposer opens the pull request that carries a whitelist change. Several
// apps travel in one pull request: granting a shared secret is one decision.
type Proposer interface {
	ProposeAll(ctx context.Context, changes []gitops.Change) (string, error)
}

// Rewirer opens the pull request that moves a chart's ExternalSecret onto
// OpenBao. A Proposer need not implement it: charts that do not spell their
// ExternalSecret in values are still wired by hand.
type Rewirer interface {
	ProposeWiring(ctx context.Context, req gitops.WiringRequest) (string, error)
}

// Whitelist turns a console action into a pull request against tesserix-k8s.
// Nothing here changes the cluster: access becomes real when that pull request
// is merged and ArgoCD syncs it.
type Whitelist struct {
	proposer Proposer
	rewirer  Rewirer
	audit    *audit.Logger
}

func NewWhitelist(p Proposer, log *audit.Logger) *Whitelist {
	h := &Whitelist{proposer: p, audit: log}
	if r, ok := p.(Rewirer); ok {
		h.rewirer = r
	}
	return h
}

func (h *Whitelist) Register(r gin.IRoutes) {
	r.POST("/api/access/whitelist", h.Propose)
	r.DELETE("/api/access/whitelist/:namespace/:app", h.Withdraw)
	r.POST("/api/access/wiring", h.Rewire)
}

type whitelistRequest struct {
	Namespace string `json:"namespace" binding:"required"`
	Apps      []struct {
		Name           string `json:"name" binding:"required"`
		ServiceAccount string `json:"serviceAccount" binding:"required"`
	} `json:"apps" binding:"required,min=1,dive"`
}

func (h *Whitelist) Propose(c *gin.Context) {
	var req whitelistRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must be {\"namespace\":…,\"apps\":[{\"name\":…,\"serviceAccount\":…}]}"})
		return
	}

	changes := make([]gitops.Change, 0, len(req.Apps))
	names := make([]string, 0, len(req.Apps))
	for _, app := range req.Apps {
		changes = append(changes, gitops.Change{
			Add: &gitops.App{Namespace: req.Namespace, Name: app.Name, ServiceAccount: app.ServiceAccount},
		})
		names = append(names, app.Name)
	}

	h.submit(c, audit.ActionWhitelistPropose, changes, req.Namespace, strings.Join(names, ","))
}

func (h *Whitelist) Withdraw(c *gin.Context) {
	namespace, app := c.Param("namespace"), c.Param("app")

	h.submit(c, audit.ActionWhitelistWithdraw, []gitops.Change{{
		Remove: &gitops.App{Namespace: namespace, Name: app},
	}}, namespace, app)
}

type wiringRequest struct {
	Namespace      string `json:"namespace" binding:"required"`
	App            string `json:"app" binding:"required"`
	ChartPath      string `json:"chartPath" binding:"required"`
	ValuesFile     string `json:"valuesFile" binding:"required"`
	RemoteKey      string `json:"remoteKey" binding:"required"`
	RemoteProperty string `json:"remoteProperty"`
}

// Rewire proposes the chart change that points an app at its OpenBao store. It
// grants nothing on its own: the app must already be whitelisted, or External
// Secrets has no store to read from.
func (h *Whitelist) Rewire(c *gin.Context) {
	var req wiringRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must be {\"namespace\":…,\"app\":…,\"chartPath\":…,\"valuesFile\":…,\"remoteKey\":…}"})
		return
	}
	if h.rewirer == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no chart repository is configured"})
		return
	}

	proposal := gitops.WiringRequest{
		Namespace:  req.Namespace,
		ChartPath:  req.ChartPath,
		ValuesFile: req.ValuesFile,
		Wiring: gitops.Wiring{
			App:            req.App,
			RemoteKey:      req.RemoteKey,
			RemoteProperty: req.RemoteProperty,
		},
	}
	if p, ok := middleware.PrincipalFrom(c); ok {
		proposal.Actor = p.Email
	}

	target := req.Namespace + "/" + req.App
	url, err := h.rewirer.ProposeWiring(c.Request.Context(), proposal)
	if err != nil {
		h.record(c, audit.ActionWhitelistRewire, target, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	h.record(c, audit.ActionWhitelistRewire, target, nil)
	c.JSON(http.StatusOK, gin.H{"namespace": req.Namespace, "app": req.App, "pullRequest": url, "status": "proposed"})
}

func (h *Whitelist) submit(c *gin.Context, action audit.Action, changes []gitops.Change, namespace, app string) {
	if h.proposer == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no whitelist repository is configured"})
		return
	}

	target := namespace + "/" + app
	for i := range changes {
		if p, ok := middleware.PrincipalFrom(c); ok {
			changes[i].Actor = p.Email
		}
		changes[i].Summary = string(action) + " " + target
	}

	url, err := h.proposer.ProposeAll(c.Request.Context(), changes)
	h.record(c, action, target, err)
	switch {
	case errors.Is(err, gitops.ErrNoChange):
		// The whitelist already says what the administrator asked it to say.
		// That is the requested state, so it is a success, and answering 502
		// would report a fault where there is none. There is no pull request to
		// link to, and the status says so rather than leaving an empty URL for
		// the console to render as a broken link.
		c.JSON(http.StatusOK, gin.H{"namespace": namespace, "app": app, "status": "unchanged"})
	case err != nil:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusOK, gin.H{"namespace": namespace, "app": app, "pullRequest": url, "status": "proposed"})
	}
}

func (h *Whitelist) record(c *gin.Context, action audit.Action, target string, err error) {
	recordEvent(h.audit, c, action, target, err)
}

// reasonNoChange marks the audit entry for an action that was allowed and did
// nothing, because the state it asked for already held. A trail that cannot
// tell a proposal that opened a pull request from one that found the work
// already done evidences nothing, so the two are not written identically.
const reasonNoChange = "already in place; no pull request was opened"

// recordEvent writes the audit entry for one console action. Whitelist and
// Access share it so that the three outcomes — done, already done, failed —
// cannot drift apart between the two routes that propose the same change.
func recordEvent(log *audit.Logger, c *gin.Context, action audit.Action, target string, err error) {
	event := audit.Event{
		Action:    action,
		Target:    target,
		Outcome:   audit.OutcomeAllowed,
		RequestID: middleware.RequestIDFrom(c),
		SourceIP:  c.ClientIP(),
	}
	if p, ok := middleware.PrincipalFrom(c); ok {
		event.Actor = p.Email
	}
	switch {
	case errors.Is(err, gitops.ErrNoChange):
		event.Reason = reasonNoChange
	case err != nil:
		event.Outcome = audit.OutcomeError
		event.Reason = err.Error()
	}
	log.Record(event)
}
