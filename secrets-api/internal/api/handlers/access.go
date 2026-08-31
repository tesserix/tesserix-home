package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

// Access manages which namespaces may read from OpenBao. A grant is what ESO
// authenticates against; a denylist entry blocks one from ever being created.
type Access struct {
	bao      *bao.Client
	proposer Proposer
	audit    *audit.Logger
}

func NewAccess(client *bao.Client, p Proposer, log *audit.Logger) *Access {
	return &Access{bao: client, proposer: p, audit: log}
}

func (h *Access) Register(g Groups) {
	g.Read.GET("/api/access/grants", h.ListGrants)
	g.Read.GET("/api/access/denied", h.ListDenied)

	// GrantAll and bao.Allow/Deny take effect in OpenBao immediately; the
	// proposal they open afterwards is a receipt, not a gate.
	g.Live.POST("/api/access/grants", h.CreateGrant)
	g.Live.DELETE("/api/access/grants/:namespace/:app", h.RevokeGrant)
	g.Live.POST("/api/access/denied", h.Deny)
	g.Live.DELETE("/api/access/denied/:namespace", h.Allow)
}

func (h *Access) ListGrants(c *gin.Context) {
	grants, err := h.bao.Grants(c.Request.Context())
	if err != nil {
		respondStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"grants": grants})
}

type grantRequest struct {
	Namespace string       `json:"namespace" binding:"required"`
	Apps      []bao.AppRef `json:"apps" binding:"required,min=1,dive"`
	// TTL is "0" for a grant that does not expire.
	TTL string `json:"ttl"`
}

func (h *Access) CreateGrant(c *gin.Context) {
	var req grantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must be {\"namespace\":…,\"apps\":[{\"name\":…,\"serviceAccount\":…}],\"ttl\":…}"})
		return
	}

	granted, err := h.bao.GrantAll(c.Request.Context(), req.Namespace, req.TTL, req.Apps)
	for _, g := range granted {
		h.record(c, audit.ActionAccessGrant, g.Namespace+"/"+g.App, nil)
	}
	if err != nil {
		h.record(c, audit.ActionAccessGrant, req.Namespace, err)
		respondStoreError(c, err)
		return
	}

	body := gin.H{"grants": granted, "status": "granted"}
	url, proposeErr := h.propose(c, granted)
	switch {
	case errors.Is(proposeErr, gitops.ErrNoChange):
		// The grant stands in OpenBao and tesserix-k8s already describes it, so
		// there is nothing to record and nothing went wrong. Reporting this as
		// a proposalError would tell the operator their grant was not written
		// to Git when it was — written by an earlier proposal, but written.
		body["proposal"] = "unchanged"
	case proposeErr != nil:
		body["proposalError"] = proposeErr.Error()
	default:
		body["pullRequest"] = url
	}
	c.JSON(http.StatusOK, body)
}

// propose records the grant in tesserix-k8s. The OpenBao role alone lives only
// in raft: without this the SecretStore ESO reads through is never created, and
// a rebuilt OpenBao comes back with no memory of the grant.
func (h *Access) propose(c *gin.Context, granted []bao.Grant) (string, error) {
	if h.proposer == nil {
		return "", errors.New("no whitelist repository is configured; this grant is not recorded in Git")
	}

	actor := ""
	if p, ok := middleware.BearerPrincipalFrom(c); ok {
		actor = p.Subject
	}

	changes := make([]gitops.Change, 0, len(granted))
	for _, g := range granted {
		changes = append(changes, gitops.Change{
			Add:     &gitops.App{Namespace: g.Namespace, Name: g.App, ServiceAccount: g.ServiceAccount},
			Actor:   actor,
			Summary: string(audit.ActionWhitelistPropose) + " " + g.Namespace + "/" + g.App,
		})
	}

	url, err := h.proposer.ProposeAll(c.Request.Context(), changes)
	target := granted[0].Namespace
	h.record(c, audit.ActionWhitelistPropose, target, err)
	return url, err
}

func (h *Access) RevokeGrant(c *gin.Context) {
	namespace, app := c.Param("namespace"), c.Param("app")
	target := namespace + "/" + app

	if err := h.bao.Revoke(c.Request.Context(), namespace, app); err != nil {
		h.record(c, audit.ActionAccessRevoke, target, err)
		respondStoreError(c, err)
		return
	}

	h.record(c, audit.ActionAccessRevoke, target, nil)
	c.JSON(http.StatusOK, gin.H{"namespace": namespace, "app": app, "status": "revoked"})
}

func (h *Access) ListDenied(c *gin.Context) {
	denied, err := h.bao.Denied(c.Request.Context())
	if err != nil {
		respondStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"denied": denied})
}

type denyRequest struct {
	Namespace string `json:"namespace" binding:"required"`
	Reason    string `json:"reason" binding:"required"`
}

func (h *Access) Deny(c *gin.Context) {
	var req denyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must be {\"namespace\":…,\"reason\":…}"})
		return
	}

	actor := ""
	if p, ok := middleware.BearerPrincipalFrom(c); ok {
		actor = p.Subject
	}

	if err := h.bao.Deny(c.Request.Context(), req.Namespace, req.Reason, actor); err != nil {
		h.record(c, audit.ActionAccessDeny, req.Namespace, err)
		respondStoreError(c, err)
		return
	}

	h.record(c, audit.ActionAccessDeny, req.Namespace, nil)
	c.JSON(http.StatusOK, gin.H{"namespace": req.Namespace, "status": "denied"})
}

func (h *Access) Allow(c *gin.Context) {
	namespace := c.Param("namespace")

	if err := h.bao.Allow(c.Request.Context(), namespace); err != nil {
		h.record(c, audit.ActionAccessAllow, namespace, err)
		respondStoreError(c, err)
		return
	}

	h.record(c, audit.ActionAccessAllow, namespace, nil)
	c.JSON(http.StatusOK, gin.H{"namespace": namespace, "status": "allowed"})
}

func (h *Access) record(c *gin.Context, action audit.Action, target string, err error) {
	recordEvent(h.audit, c, action, target, err)
}
