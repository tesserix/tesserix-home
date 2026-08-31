package middleware

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

const (
	// The __Host- prefix stops a sibling subdomain overwriting the cookie, but
	// browsers only honour it on a Secure cookie — so plain http development
	// drops the prefix rather than silently having no cookie at all.
	SessionCookieName    = "__Host-secret_session"
	DevSessionCookieName = "secret_session"

	principalKey = "principal"
)

func SessionCookie(secure bool) string {
	if secure {
		return SessionCookieName
	}
	return DevSessionCookieName
}

type Principal struct {
	Subject string
	Email   string
	Name    string
	// ExpiresAt lets the console warn before the session lapses instead of
	// discarding a half-typed secret at the next request.
	ExpiresAt time.Time
}

// RequireSession admits only a session that is intact, unexpired and still on
// the allowlist. The allowlist is re-checked per request so that removing an
// address takes effect immediately rather than when the cookie expires.
func RequireSession(sealer *auth.Sealer, allow *auth.Allowlist, cookieName string) gin.HandlerFunc {
	return func(c *gin.Context) {
		cookie, err := c.Cookie(cookieName)
		if err != nil || cookie == "" {
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}

		sess, err := sealer.Open(cookie)
		if err != nil {
			ClearSession(c, cookieName)
			if errors.Is(err, auth.ErrSessionExpired) {
				abort(c, http.StatusUnauthorized, "session expired")
				return
			}
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}

		if !allow.Permits(sess.Email) {
			ClearSession(c, cookieName)
			abort(c, http.StatusForbidden, "not authorised for this service")
			return
		}

		c.Set(principalKey, Principal{Subject: sess.Subject, Email: sess.Email, Name: sess.Name, ExpiresAt: sess.ExpiresAt})
		c.Next()
	}
}

func PrincipalFrom(c *gin.Context) (Principal, bool) {
	v, ok := c.Get(principalKey)
	if !ok {
		return Principal{}, false
	}
	p, ok := v.(Principal)
	return p, ok
}

func ClearSession(c *gin.Context, cookieName string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

func abort(c *gin.Context, status int, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": message})
}
