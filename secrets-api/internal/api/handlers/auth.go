package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
)

// loginStateCookie mirrors the session cookie's __Host- rule; see middleware.
const loginStateCookie = "__Host-secret_login"
const devLoginStateCookie = "secret_login"

type Auth struct {
	cfg    config.Config
	flow   *auth.Flow
	sealer *auth.Sealer
	allow  *auth.Allowlist
	audit  *audit.Logger

	sessionCookie string
	loginCookie   string
}

func NewAuth(cfg config.Config, flow *auth.Flow, sealer *auth.Sealer, allow *auth.Allowlist, log *audit.Logger) *Auth {
	h := &Auth{cfg: cfg, flow: flow, sealer: sealer, allow: allow, audit: log}
	h.sessionCookie = middleware.SessionCookie(cfg.IsSecure())
	h.loginCookie = devLoginStateCookie
	if cfg.IsSecure() {
		h.loginCookie = loginStateCookie
	}
	return h
}

func (h *Auth) Register(r gin.IRoutes) {
	r.GET("/api/auth/login", h.Login)
	r.GET("/api/auth/callback", h.Callback)
	r.POST("/api/auth/logout", h.Logout)
}

func (h *Auth) Login(c *gin.Context) {
	pkce, err := auth.NewPKCE()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start login"})
		return
	}
	state, err := auth.RandomToken(32)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start login"})
		return
	}

	sealed, err := h.sealer.SealLoginState(auth.LoginState{
		State:     state,
		Verifier:  pkce.Verifier,
		ReturnTo:  safeReturnTo(c.Query("returnTo")),
		ExpiresAt: time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start login"})
		return
	}

	h.setCookie(c, h.loginCookie, sealed, 600, true)
	c.Redirect(http.StatusFound, h.flow.AuthCodeURL(state, pkce))
}

func (h *Auth) Callback(c *gin.Context) {
	sealed, err := c.Cookie(h.loginCookie)
	if err != nil || sealed == "" {
		h.fail(c, "login_expired")
		return
	}
	h.clearCookie(c, h.loginCookie)

	state, err := h.sealer.OpenLoginState(sealed)
	if err != nil {
		h.fail(c, "login_expired")
		return
	}
	if c.Query("state") == "" || c.Query("state") != state.State {
		h.fail(c, "state_mismatch")
		return
	}
	if errParam := c.Query("error"); errParam != "" {
		h.fail(c, "idp_error")
		return
	}

	claims, err := h.flow.Exchange(c.Request.Context(), c.Query("code"), state.Verifier)
	if err != nil {
		h.fail(c, "token_exchange_failed")
		return
	}

	if !h.allow.Permits(claims.Email) {
		h.audit.Record(audit.Event{
			Actor:     claims.Email,
			Action:    audit.ActionLoginDenied,
			Outcome:   audit.OutcomeDenied,
			Reason:    "not on the allowlist",
			RequestID: middleware.RequestIDFrom(c),
			SourceIP:  c.ClientIP(),
		})
		h.fail(c, "not_authorised")
		return
	}

	session, err := h.sealer.Seal(auth.Session{
		Subject:   claims.Subject,
		Email:     claims.Email,
		Name:      claims.Name,
		ExpiresAt: time.Now().Add(h.cfg.SessionTTL),
	})
	if err != nil {
		h.fail(c, "session_failed")
		return
	}

	csrf, err := auth.RandomToken(32)
	if err != nil {
		h.fail(c, "session_failed")
		return
	}

	ttl := int(h.cfg.SessionTTL.Seconds())
	h.setCookie(c, h.sessionCookie, session, ttl, true)
	h.setCookie(c, middleware.CSRFCookieName, csrf, ttl, false)

	h.audit.Record(audit.Event{
		Actor:     claims.Email,
		Action:    audit.ActionLogin,
		Outcome:   audit.OutcomeAllowed,
		RequestID: middleware.RequestIDFrom(c),
		SourceIP:  c.ClientIP(),
	})

	c.Redirect(http.StatusFound, h.cfg.BaseURL+state.ReturnTo)
}

func (h *Auth) Logout(c *gin.Context) {
	if p, ok := middleware.PrincipalFrom(c); ok {
		h.audit.Record(audit.Event{
			Actor:     p.Email,
			Action:    audit.ActionLogout,
			Outcome:   audit.OutcomeAllowed,
			RequestID: middleware.RequestIDFrom(c),
			SourceIP:  c.ClientIP(),
		})
	}
	h.clearCookie(c, h.sessionCookie)
	h.clearCookie(c, middleware.CSRFCookieName)
	c.JSON(http.StatusOK, gin.H{"status": "signed out"})
}

// Me is mounted behind RequireSession, so reaching it proves the caller is an
// allowlisted administrator.
func (h *Auth) Me(c *gin.Context) {
	p, ok := middleware.PrincipalFrom(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"email": p.Email, "name": p.Name, "subject": p.Subject, "expiresAt": p.ExpiresAt})
}

func (h *Auth) setCookie(c *gin.Context, name, value string, maxAge int, httpOnly bool) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: httpOnly,
		Secure:   h.cfg.IsSecure(),
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Auth) clearCookie(c *gin.Context, name string) {
	h.setCookie(c, name, "", -1, true)
}

func (h *Auth) fail(c *gin.Context, reason string) {
	c.Redirect(http.StatusFound, h.cfg.BaseURL+"/sign-in?error="+reason)
}

// safeReturnTo keeps the post-login redirect inside this application: an
// attacker-supplied absolute URL would turn login into an open redirect.
func safeReturnTo(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return "/"
	}
	if strings.ContainsAny(raw, "\r\n\\") {
		return "/"
	}
	return raw
}
