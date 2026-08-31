package middleware_test

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
)

const admin = "samyak.rout@gmail.com"

func init() { gin.SetMode(gin.TestMode) }

func newSealer(t *testing.T) *auth.Sealer {
	t.Helper()
	key := make([]byte, auth.SealerKeySize)
	for i := range key {
		key[i] = byte(i)
	}
	s, err := auth.NewSealer(key)
	if err != nil {
		t.Fatalf("NewSealer: %v", err)
	}
	return s
}

// guardedRouter mounts RequireSession over a handler that reports the principal
// it saw, so tests assert on observable behaviour rather than on context keys.
func guardedRouter(t *testing.T, sealer *auth.Sealer, allow *auth.Allowlist) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.GET("/guarded", middleware.RequireSession(sealer, allow, middleware.SessionCookieName), func(c *gin.Context) {
		p, ok := middleware.PrincipalFrom(c)
		if !ok {
			c.String(http.StatusInternalServerError, "no principal")
			return
		}
		c.String(http.StatusOK, p.Email)
	})
	return r
}

func requestWithSession(t *testing.T, sealer *auth.Sealer, sess auth.Session) *http.Request {
	t.Helper()
	token, err := sealer.Seal(sess)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/guarded", nil)
	req.AddCookie(&http.Cookie{Name: middleware.SessionCookieName, Value: token})
	return req
}

func TestRequireSessionAdmitsAnAllowlistedSession(t *testing.T) {
	sealer := newSealer(t)
	r := guardedRouter(t, sealer, auth.NewAllowlist([]string{admin}))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, requestWithSession(t, sealer, auth.Session{
		Email:     admin,
		ExpiresAt: time.Now().Add(time.Hour),
	}))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if w.Body.String() != admin {
		t.Fatalf("handler saw principal %q, want %q", w.Body.String(), admin)
	}
}

// The console warns before a session lapses rather than losing a half-typed
// secret to a redirect, which it can only do if the expiry reaches the handler.
func TestRequireSessionCarriesTheSessionExpiryOnThePrincipal(t *testing.T) {
	sealer := newSealer(t)
	expires := time.Now().Add(90 * time.Minute).UTC().Truncate(time.Second)

	r := gin.New()
	r.GET("/guarded", middleware.RequireSession(sealer, auth.NewAllowlist([]string{admin}), middleware.SessionCookieName), func(c *gin.Context) {
		p, _ := middleware.PrincipalFrom(c)
		c.String(http.StatusOK, p.ExpiresAt.UTC().Format(time.RFC3339))
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, requestWithSession(t, sealer, auth.Session{Email: admin, ExpiresAt: expires}))

	if got := w.Body.String(); got != expires.Format(time.RFC3339) {
		t.Fatalf("principal expiry = %q, want %q", got, expires.Format(time.RFC3339))
	}
}

func TestRequireSessionRejectsMissingCookie(t *testing.T) {
	r := guardedRouter(t, newSealer(t), auth.NewAllowlist([]string{admin}))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/guarded", nil))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// Removing an address from ADMIN_EMAILS must lock out a session that is still
// cryptographically valid — the allowlist is checked on every request.
func TestRequireSessionRejectsSessionWhoseEmailLeftTheAllowlist(t *testing.T) {
	sealer := newSealer(t)
	r := guardedRouter(t, sealer, auth.NewAllowlist([]string{"someone.else@gmail.com"}))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, requestWithSession(t, sealer, auth.Session{
		Email:     admin,
		ExpiresAt: time.Now().Add(time.Hour),
	}))

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestRequireSessionRejectsExpiredSession(t *testing.T) {
	sealer := newSealer(t)
	r := guardedRouter(t, sealer, auth.NewAllowlist([]string{admin}))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, requestWithSession(t, sealer, auth.Session{
		Email:     admin,
		ExpiresAt: time.Now().Add(-time.Minute),
	}))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestRequireSessionRejectsTamperedCookie(t *testing.T) {
	sealer := newSealer(t)
	r := guardedRouter(t, sealer, auth.NewAllowlist([]string{admin}))

	req := requestWithSession(t, sealer, auth.Session{Email: admin, ExpiresAt: time.Now().Add(time.Hour)})
	cookie := req.Cookies()[0]
	sealed, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		t.Fatalf("decode cookie: %v", err)
	}
	// A ciphertext bit, not a base64 character: the final character of a
	// RawURLEncoding token carries unused low bits, so flipping it decodes to
	// the same bytes two times in three and tampers with nothing.
	sealed[len(sealed)-1] ^= 0x01
	req.Header.Set("Cookie", middleware.SessionCookieName+"="+base64.RawURLEncoding.EncodeToString(sealed))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestRequireSessionClearsTheCookieOnRejection(t *testing.T) {
	r := guardedRouter(t, newSealer(t), auth.NewAllowlist([]string{admin}))

	req := httptest.NewRequest(http.MethodGet, "/guarded", nil)
	req.AddCookie(&http.Cookie{Name: middleware.SessionCookieName, Value: "garbage"})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if w.Header().Get("Set-Cookie") == "" {
		t.Fatal("rejection did not clear the bad session cookie")
	}
}
