package handlers

import (
	"context"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/gitops"
)

// Reviewer is the queue of console-raised changes an administrator works
// through: read the diff, then merge it or reject it. ArgoCD syncs what is
// merged; a rejected proposal leaves no branch behind to start again from.
type Reviewer interface {
	Pulls(ctx context.Context) ([]gitops.PullRequest, error)
	Pull(ctx context.Context, number int) (gitops.PullDetail, error)
	Approve(ctx context.Context, number int, actor string) error
	Merge(ctx context.Context, number int, actor string) (string, error)
	Reject(ctx context.Context, number int, actor, reason string) error
}

type Reviews struct {
	reviewer Reviewer
	audit    *audit.Logger
}

func NewReviews(r Reviewer, log *audit.Logger) *Reviews {
	return &Reviews{reviewer: r, audit: log}
}

func (h *Reviews) Register(read, live gin.IRoutes) {
	read.GET("/api/reviews", h.List)
	read.GET("/api/reviews/:number", h.Show)

	live.POST("/api/reviews/:number/approve", h.Approve)
	live.POST("/api/reviews/:number/merge", h.Merge)
	live.POST("/api/reviews/:number/reject", h.Reject)
}

func (h *Reviews) List(c *gin.Context) {
	if !h.configured(c) {
		return
	}

	pulls, err := h.reviewer.Pulls(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"pulls": pulls})
}

func (h *Reviews) Show(c *gin.Context) {
	number, ok := h.number(c)
	if !ok {
		return
	}

	detail, err := h.reviewer.Pull(c.Request.Context(), number)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, detail)
}

func (h *Reviews) Approve(c *gin.Context) {
	number, ok := h.number(c)
	if !ok {
		return
	}

	actor := actorOf(c)
	err := h.reviewer.Approve(c.Request.Context(), number, actor)
	h.record(c, audit.ActionReviewApprove, number, err)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"number": number, "status": "approved"})
}

func (h *Reviews) Merge(c *gin.Context) {
	number, ok := h.number(c)
	if !ok {
		return
	}

	sha, err := h.reviewer.Merge(c.Request.Context(), number, actorOf(c))
	h.record(c, audit.ActionReviewMerge, number, err)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// ArgoCD auto-syncs the repository, so the change lands without the console
	// asking the cluster for anything.
	c.JSON(http.StatusOK, gin.H{"number": number, "sha": sha, "status": "merged"})
}

func (h *Reviews) Reject(c *gin.Context) {
	number, ok := h.number(c)
	if !ok {
		return
	}

	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)

	err := h.reviewer.Reject(c.Request.Context(), number, actorOf(c), body.Reason)
	h.record(c, audit.ActionReviewReject, number, err)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"number": number, "status": "rejected"})
}

func (h *Reviews) configured(c *gin.Context) bool {
	if h.reviewer == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no review repository is configured"})
		return false
	}
	return true
}

func (h *Reviews) number(c *gin.Context) (int, bool) {
	if !h.configured(c) {
		return 0, false
	}
	number, err := strconv.Atoi(c.Param("number"))
	if err != nil || number <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pull request number must be a positive integer"})
		return 0, false
	}
	return number, true
}

func actorOf(c *gin.Context) string {
	if p, ok := middleware.BearerPrincipalFrom(c); ok {
		return p.Subject
	}
	return ""
}

func (h *Reviews) record(c *gin.Context, action audit.Action, number int, err error) {
	event := audit.Event{
		Action:    action,
		Target:    "pull/" + strconv.Itoa(number),
		Outcome:   audit.OutcomeAllowed,
		Actor:     actorOf(c),
		RequestID: middleware.RequestIDFrom(c),
		SourceIP:  c.ClientIP(),
	}
	if err != nil {
		event.Outcome = audit.OutcomeError
		event.Reason = err.Error()
	}
	h.audit.Record(event)
}
