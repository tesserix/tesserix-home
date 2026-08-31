package middleware

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	RequestIDHeader = "X-Request-Id"
	requestIDKey    = "requestId"
)

func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(RequestIDHeader)
		if id == "" {
			id = uuid.NewString()
		}
		c.Set(requestIDKey, id)
		c.Header(RequestIDHeader, id)
		c.Next()
	}
}

func RequestIDFrom(c *gin.Context) string { return c.GetString(requestIDKey) }

// SecurityHeaders sets the response hardening for an app that renders secrets.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		// Secrets must never reach a shared cache or the browser's disk cache.
		h.Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
		h.Set("Pragma", "no-cache")
		c.Next()
	}
}

func Logger(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		attrs := []any{
			"method", c.Request.Method,
			"path", c.FullPath(),
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"requestId", RequestIDFrom(c),
		}
		if p, ok := PrincipalFrom(c); ok {
			attrs = append(attrs, "actor", p.Email)
		}

		if c.Writer.Status() >= http.StatusInternalServerError {
			log.Error("request", attrs...)
			return
		}
		log.Info("request", attrs...)
	}
}
