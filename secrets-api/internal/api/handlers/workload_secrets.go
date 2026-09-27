package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
	"github.com/tesserix/tesserix-home/secrets-api/internal/workloadauth"
)

const maxWorkloadSecretBytes = 256 * 1024

var (
	ownerPattern  = regexp.MustCompile(`^[a-f0-9]{32}$`)
	secretPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$`)
)

type WorkloadSecretWriter interface {
	Write(ctx context.Context, path string, data map[string]string, ifVersion int) (int, error)
	Delete(ctx context.Context, path string) error
}

type WorkloadSecretsConfig struct {
	Audience        string
	AllowedSubjects []string
	Namespace       string
	App             string
}

type WorkloadSecrets struct {
	cfg     WorkloadSecretsConfig
	allowed map[string]struct{}
	review  workloadauth.Reviewer
	store   WorkloadSecretWriter
	audit   *audit.Logger
}

func NewWorkloadSecrets(
	cfg WorkloadSecretsConfig,
	reviewer workloadauth.Reviewer,
	store WorkloadSecretWriter,
	log *audit.Logger,
) (*WorkloadSecrets, error) {
	if reviewer == nil || store == nil || log == nil {
		return nil, errors.New("workload secrets: reviewer, store and audit logger are required")
	}
	if cfg.Audience == "" || !secrets.IsDNSLabel(cfg.Namespace) || !secrets.IsDNSLabel(cfg.App) {
		return nil, errors.New("workload secrets: audience, namespace and app are required")
	}
	allowed := make(map[string]struct{}, len(cfg.AllowedSubjects))
	for _, subject := range cfg.AllowedSubjects {
		if subject = strings.TrimSpace(subject); subject != "" {
			allowed[subject] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		return nil, errors.New("workload secrets: at least one allowed subject is required")
	}
	return &WorkloadSecrets{cfg: cfg, allowed: allowed, review: reviewer, store: store, audit: log}, nil
}

func (h *WorkloadSecrets) Register(r gin.IRoutes) {
	r.GET("/internal/v1/workload-secrets/capabilities", h.authenticate, h.capabilities)
	r.PUT("/internal/v1/workload-secrets/:owner/:secret", h.authenticate, h.write)
	r.DELETE("/internal/v1/workload-secrets/:owner/:secret", h.authenticate, h.delete)
}

func (h *WorkloadSecrets) authenticate(c *gin.Context) {
	authorization := c.GetHeader("Authorization")
	token, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok || strings.TrimSpace(token) == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "workload bearer token required"})
		return
	}
	identity, err := h.review.Review(c.Request.Context(), strings.TrimSpace(token), h.cfg.Audience)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "workload token is not authenticated"})
		return
	}
	if _, ok := h.allowed[identity.Subject]; !ok {
		h.record(c, identity.Subject, audit.ActionAccessDeny, "", errors.New("subject is not allowlisted"), nil)
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "workload is not allowed"})
		return
	}
	c.Set("workload-subject", identity.Subject)
	c.Next()
}

func (h *WorkloadSecrets) capabilities(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"write": true, "delete": "soft", "namespace": h.cfg.Namespace, "app": h.cfg.App})
}

type workloadWriteRequest struct {
	Value     string `json:"value"`
	IfVersion int    `json:"ifVersion"`
}

func (h *WorkloadSecrets) write(c *gin.Context) {
	path, ok := h.path(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxWorkloadSecretBytes+1024)
	var req workloadWriteRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Value == "" || len(req.Value) > maxWorkloadSecretBytes || req.IfVersion < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must contain a non-empty value, optional non-negative ifVersion"})
		return
	}
	version, err := h.store.Write(c.Request.Context(), path, map[string]string{"value": req.Value}, req.IfVersion)
	h.record(c, c.GetString("workload-subject"), audit.ActionSecretWrite, path, err, []string{"value"})
	if err != nil {
		respondStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": path, "version": version, "backend": secrets.BackendOpenBao})
}

func (h *WorkloadSecrets) delete(c *gin.Context) {
	path, ok := h.path(c)
	if !ok {
		return
	}
	err := h.store.Delete(c.Request.Context(), path)
	h.record(c, c.GetString("workload-subject"), audit.ActionSecretDelete, path, err, nil)
	if err != nil {
		respondStoreError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *WorkloadSecrets) path(c *gin.Context) (string, bool) {
	owner, name := c.Param("owner"), c.Param("secret")
	if !ownerPattern.MatchString(owner) || !secretPattern.MatchString(name) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid owner or secret name"})
		return "", false
	}
	return fmt.Sprintf("%s/%s/%s/%s", h.cfg.Namespace, h.cfg.App, owner, name), true
}

func (h *WorkloadSecrets) record(c *gin.Context, actor string, action audit.Action, target string, err error, keys []string) {
	outcome := audit.OutcomeAllowed
	reason := ""
	if err != nil {
		outcome, reason = audit.OutcomeError, err.Error()
	}
	h.audit.Record(audit.Event{
		Actor:     actor,
		Action:    action,
		Target:    target,
		Backend:   string(secrets.BackendOpenBao),
		Outcome:   outcome,
		Reason:    reason,
		RequestID: middleware.RequestIDFrom(c),
		SourceIP:  c.ClientIP(),
		Keys:      keys,
	})
}
