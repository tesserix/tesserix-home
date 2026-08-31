package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
)

func newAuthHandler(t *testing.T) *Auth {
	t.Helper()
	sealer, err := auth.NewSealer(make([]byte, auth.SealerKeySize))
	if err != nil {
		t.Fatalf("sealer: %v", err)
	}
	cfg := config.Config{BaseURL: "https://secret-service.tesserix.app"}
	return NewAuth(cfg, nil, sealer, auth.NewAllowlist([]string{"admin@example.com"}), audit.New(io.Discard))
}

func TestCallbackFailureRedirectsToSignInPage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	newAuthHandler(t).Register(r)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/auth/callback", nil))

	if got, want := rec.Code, http.StatusFound; got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
	want := "https://secret-service.tesserix.app/sign-in?error=login_expired"
	if got := rec.Header().Get("Location"); got != want {
		t.Fatalf("Location = %q, want %q", got, want)
	}
}

// The console counts down to the expiry it is told, so Me has to state it.
func TestMeReportsWhenTheSessionExpires(t *testing.T) {
	gin.SetMode(gin.TestMode)
	expires := time.Now().Add(30 * time.Minute).UTC().Truncate(time.Second)

	r := gin.New()
	r.GET("/api/auth/me", func(c *gin.Context) {
		c.Set("principal", middleware.Principal{Email: "admin@example.com", ExpiresAt: expires})
		newAuthHandler(t).Me(c)
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))

	var body struct {
		Email     string    `json:"email"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", rec.Body, err)
	}
	if !body.ExpiresAt.Equal(expires) {
		t.Fatalf("expiresAt = %s, want %s", body.ExpiresAt, expires)
	}
}

func TestLoginAcceptsReturnToFromTheConsole(t *testing.T) {
	for _, tt := range []struct {
		raw  string
		want string
	}{
		{"/access", "/access"},
		{"https://evil.example.com/", "/"},
		{"//evil.example.com/", "/"},
		{"", "/"},
	} {
		if got := safeReturnTo(tt.raw); got != tt.want {
			t.Errorf("safeReturnTo(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}
