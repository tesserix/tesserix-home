package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/recovery"
)

// Recovery exposes catalog metadata and fixed, audited recovery operations.
type Recovery struct {
	service *recovery.Service
	audit   *audit.Logger
}

func NewRecovery(service *recovery.Service, log *audit.Logger) *Recovery {
	return &Recovery{service: service, audit: log}
}
func (h *Recovery) Register(groups Groups) {
	groups.Read.GET("/api/recovery", h.Status)
	groups.Live.POST("/api/recovery/jobs", h.Start)
}
func (h *Recovery) Status(c *gin.Context) {
	if h.service == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "recovery controls unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	status, err := h.service.Status(ctx)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "recovery status unavailable"})
		return
	}
	c.JSON(http.StatusOK, status)
}
func (h *Recovery) Start(c *gin.Context) {
	if h.service == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "recovery controls unavailable"})
		return
	}
	var body struct {
		Operation string `json:"operation"`
		Key       string `json:"idempotencyKey"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recovery request"})
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recovery request"})
		return
	}
	if body.Operation != "backup" && body.Operation != "restore-test" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported recovery operation"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	job, err := h.service.Start(ctx, actorOf(c), body.Operation, body.Key)
	event := audit.Event{Actor: actorOf(c), Action: audit.Action("recovery." + body.Operation + ".start"), Target: job.Name, Outcome: audit.OutcomeAllowed, RequestID: middleware.RequestIDFrom(c), SourceIP: c.ClientIP()}
	if err != nil {
		event.Outcome = audit.OutcomeError
		event.Reason = "operation could not be started"
	}
	h.audit.Record(event)
	if errors.Is(err, recovery.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recovery request"})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "recovery operation could not be started; retry with the same request key"})
		return
	}
	c.JSON(http.StatusAccepted, job)
}
