package handlers

import (
	"errors"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

type Secrets struct {
	registry *secrets.Registry
	audit    *audit.Logger
}

func NewSecrets(registry *secrets.Registry, log *audit.Logger) *Secrets {
	return &Secrets{registry: registry, audit: log}
}

func (h *Secrets) Register(g Groups) {
	g.Read.GET("/api/backends", h.Backends)
	g.Read.GET("/api/backends/status", h.Status)
	g.Read.GET("/api/secrets", h.List)
	g.Read.GET("/api/secrets/*path", h.Describe)
	g.Read.GET("/api/secret-versions/*path", h.Versions)

	g.Live.PUT("/api/secrets/*path", h.Write)
	g.Live.DELETE("/api/secrets/*path", h.Delete)
	g.Live.POST("/api/secret-versions/*path", h.Restore)
}

// Backends tells the console which stores this deployment enabled, so the
// switcher offers exactly what the API will accept.
func (h *Secrets) Backends(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"backends": h.registry.Backends(), "default": h.registry.Default()})
}

// Status reports each enabled store's reachability. A sealed OpenBao otherwise
// shows up as an unexplained failure on whatever the administrator clicked next.
func (h *Secrets) Status(c *gin.Context) {
	type backendStatus struct {
		Backend secrets.Backend `json:"backend"`
		Healthy bool            `json:"healthy"`
		Detail  string          `json:"detail,omitempty"`
	}

	out := make([]backendStatus, 0, len(h.registry.Backends()))
	for _, name := range h.registry.Backends() {
		store, _, err := h.registry.Resolve(string(name))
		if err != nil {
			continue
		}
		status := backendStatus{Backend: name, Healthy: true}
		if err := store.Health(c.Request.Context()); err != nil {
			status.Healthy, status.Detail = false, err.Error()
		}
		out = append(out, status)
	}
	c.JSON(http.StatusOK, gin.H{"status": out})
}

// store resolves the backend named on the request, answering the caller
// directly when it is not one this deployment enabled.
func (h *Secrets) store(c *gin.Context) (secrets.Store, secrets.Backend, bool) {
	store, backend, err := h.registry.Resolve(c.Query("backend"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown backend"})
		return nil, "", false
	}
	return store, backend, true
}

func (h *Secrets) List(c *gin.Context) {
	store, backend, ok := h.store(c)
	if !ok {
		return
	}
	prefix := c.DefaultQuery("prefix", "/")

	entries, err := store.List(c.Request.Context(), prefix)
	if err != nil {
		if errors.Is(err, secrets.ErrNotFound) {
			c.JSON(http.StatusOK, gin.H{"prefix": prefix, "entries": []secrets.Entry{}})
			return
		}
		h.record(c, backend, audit.ActionSecretList, prefix, err, nil)
		respondStoreError(c, err)
		return
	}

	h.record(c, backend, audit.ActionSecretList, prefix, nil, nil)
	c.JSON(http.StatusOK, gin.H{"prefix": prefix, "entries": entries})
}

// Describe returns a secret's shape — version, timestamps, key names — and
// never its values. No endpoint on this service returns a value: only the app
// bound to the path can read one, straight from the backend via ESO.
func (h *Secrets) Describe(c *gin.Context) {
	store, backend, ok := h.store(c)
	if !ok {
		return
	}
	path := c.Param("path")

	secret, err := store.Describe(c.Request.Context(), path)
	if err != nil {
		h.record(c, backend, audit.ActionSecretDescribe, path, err, nil)
		respondStoreError(c, err)
		return
	}

	h.record(c, backend, audit.ActionSecretDescribe, secret.Path, nil, secret.Keys)
	c.JSON(http.StatusOK, secret)
}

type writeRequest struct {
	Data map[string]string `json:"data" binding:"required"`
	// IfVersion is the version the console rendered the form from. Zero means
	// the caller had none — a new secret — and writes unconditionally.
	IfVersion int `json:"ifVersion"`
}

func (h *Secrets) Write(c *gin.Context) {
	store, backend, ok := h.store(c)
	if !ok {
		return
	}
	path := c.Param("path")

	var req writeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must be {\"data\":{\"key\":\"value\"}}"})
		return
	}

	version, err := store.Write(c.Request.Context(), path, req.Data, req.IfVersion)
	if err != nil {
		h.record(c, backend, audit.ActionSecretWrite, path, err, keysOf(req.Data))
		respondStoreError(c, err)
		return
	}

	h.record(c, backend, audit.ActionSecretWrite, path, nil, keysOf(req.Data))
	c.JSON(http.StatusOK, gin.H{"path": path, "version": version, "backend": backend})
}

// Delete soft-deletes by default; ?destroy=true removes every version and is
// irreversible, so it is recorded under its own action.
func (h *Secrets) Delete(c *gin.Context) {
	store, backend, ok := h.store(c)
	if !ok {
		return
	}
	path := c.Param("path")
	destroy := c.Query("destroy") == "true"

	action := audit.ActionSecretDelete
	remove := store.Delete
	if destroy {
		action = audit.ActionSecretDestroy
		remove = store.Destroy
	}

	if err := remove(c.Request.Context(), path); err != nil {
		h.record(c, backend, action, path, err, nil)
		respondStoreError(c, err)
		return
	}

	h.record(c, backend, action, path, nil, nil)
	c.JSON(http.StatusOK, gin.H{"path": path, "destroyed": destroy})
}

func (h *Secrets) Versions(c *gin.Context) {
	store, _, ok := h.store(c)
	if !ok {
		return
	}

	versions, err := store.Versions(c.Request.Context(), c.Param("path"))
	if err != nil {
		respondStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

// Restore brings a soft-deleted version back. Only a delete can be reversed:
// a destroyed version is gone, and the backend says so rather than pretending.
func (h *Secrets) Restore(c *gin.Context) {
	store, backend, ok := h.store(c)
	if !ok {
		return
	}
	path := c.Param("path")

	var req struct {
		Version int `json:"version"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Version <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "body must be {\"version\":n} naming the version to restore"})
		return
	}

	if err := store.Restore(c.Request.Context(), path, req.Version); err != nil {
		h.record(c, backend, audit.ActionSecretRestore, path, err, nil)
		respondStoreError(c, err)
		return
	}

	h.record(c, backend, audit.ActionSecretRestore, path, nil, nil)
	c.JSON(http.StatusOK, gin.H{"path": path, "version": req.Version, "restored": true})
}

func (h *Secrets) record(c *gin.Context, backend secrets.Backend, action audit.Action, target string, err error, keys []string) {
	event := audit.Event{
		Action:    action,
		Backend:   string(backend),
		Target:    target,
		Outcome:   audit.OutcomeAllowed,
		Keys:      keys,
		RequestID: middleware.RequestIDFrom(c),
		SourceIP:  c.ClientIP(),
	}
	if p, ok := middleware.BearerPrincipalFrom(c); ok {
		event.Actor = p.Subject
	}
	if err != nil {
		event.Outcome = audit.OutcomeError
		if errors.Is(err, secrets.ErrForbidden) {
			event.Outcome = audit.OutcomeDenied
		}
		event.Reason = err.Error()
	}
	h.audit.Record(event)
}

func keysOf(data map[string]string) []string {
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// respondStoreError keeps the backend's own error text out of the response
// body; the detail goes to the audit log instead.
func respondStoreError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, secrets.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	case errors.Is(err, secrets.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "denied by backend policy"})
	case errors.Is(err, secrets.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "the secret changed while you were editing it; reload and write again"})
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	}
}
