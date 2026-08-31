package middleware

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"
)

const (
	// The CSRF cookie is deliberately readable by the SPA so it can echo the
	// value back in the header; the session cookie stays HttpOnly.
	CSRFCookieName = "secret_csrf"
	CSRFHeaderName = "X-CSRF-Token"
)

// CSRF enforces the double-submit pattern on every state-changing request.
func CSRF() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}

		cookie, err := c.Cookie(CSRFCookieName)
		header := c.GetHeader(CSRFHeaderName)

		if err != nil || cookie == "" || header == "" ||
			subtle.ConstantTimeCompare([]byte(cookie), []byte(header)) != 1 {
			abort(c, http.StatusForbidden, "csrf token missing or invalid")
			return
		}
		c.Next()
	}
}
