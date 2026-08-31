package middleware

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	authcore "github.com/tesserix/tesserix-home/platform-auth"
)

// bearerPrincipalKey keeps the context key's NAME out of other packages'
// reach, but gin's Context.Keys is map[string]any: nothing stops another
// package that guesses or hardcodes this string from calling
// c.Set("auth.bearer.principal", anything). The real protection is the
// comma-ok type assertion in BearerPrincipalFrom, which rejects a planted
// value of the wrong type rather than trusting the key alone.
const bearerPrincipalKey = "auth.bearer.principal"

// RequireBearer verifies the Zitadel bearer token and attaches the principal.
//
// It does NOT authorise. Keeping verification and authorisation in separate
// middleware is what lets each route state the capability it needs, instead of
// one gate deciding for routes it cannot see.
func RequireBearer(v *authcore.Verifier, log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, ok := bearerToken(c.Request)
		if !ok {
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}

		principal, err := v.Verify(c.Request.Context(), raw)
		if err != nil {
			// The reason goes to the log, never to the caller: ErrNoRoles names
			// the role vocabulary, and reporting it would hand that vocabulary
			// to an unauthorised client.
			if log != nil {
				log.Warn("token rejected", "error", err, "path", c.Request.URL.Path)
			}
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}

		c.Set(bearerPrincipalKey, *principal)
		c.Next()
	}
}

// RequireCapability refuses a request whose principal lacks `required`.
//
// Reached without RequireBearer it refuses with 401 rather than passing: a
// route group wired in the wrong order must deny, not allow.
func RequireCapability(required authcore.Capability) gin.HandlerFunc {
	return func(c *gin.Context) {
		principal, ok := BearerPrincipalFrom(c)
		if !ok {
			abort(c, http.StatusUnauthorized, "authentication required")
			return
		}
		if !principal.Has(required) {
			// 403, not 401: the caller is authenticated and simply lacks this
			// permission. Telling them to log in again would be a lie.
			abort(c, http.StatusForbidden, "insufficient permissions")
			return
		}
		c.Next()
	}
}

// BearerPrincipalFrom returns the principal a request was authenticated as by
// RequireBearer.
//
// The bool is not decoration: a handler reached without authentication has a
// zero Principal, which holds no capabilities, and silently treating that as a
// real caller is how an ungated route becomes an open one.
func BearerPrincipalFrom(c *gin.Context) (authcore.Principal, bool) {
	v, ok := c.Get(bearerPrincipalKey)
	if !ok {
		return authcore.Principal{}, false
	}
	p, ok := v.(authcore.Principal)
	return p, ok
}

func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	scheme, token, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}
