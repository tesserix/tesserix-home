package middleware_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
)

// stubParser stands in for Zitadel. The Verifier's policy — audience, roles,
// expiry, principal shape — is what we are testing here, not JWKS.
type stubParser struct {
	claims *authcore.Claims
	err    error
}

func (s stubParser) Parse(context.Context, string) (*authcore.Claims, error) {
	return s.claims, s.err
}

const testProject = "386377229942128837"

func verifierWith(roles []string) *authcore.Verifier {
	return authcore.NewVerifier(stubParser{claims: &authcore.Claims{
		Subject:   "user-1",
		Audience:  []string{testProject},
		Roles:     roles,
		ExpiresAt: time.Now().Add(time.Hour),
	}}, testProject)
}

func request(t *testing.T, h gin.HandlerFunc, gate gin.HandlerFunc, header string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	handlers := []gin.HandlerFunc{h}
	if gate != nil {
		handlers = append(handlers, gate)
	}
	handlers = append(handlers, func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/x", handlers...)

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if header != "" {
		req.Header.Set("Authorization", header)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestNoAuthorizationHeaderIs401(t *testing.T) {
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestNonBearerSchemeIs401(t *testing.T) {
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "Basic abc")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestValidTokenPasses(t *testing.T) {
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "Bearer a.b.c")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

// A capability the principal does not hold must be 403, not 401: the caller IS
// authenticated. Collapsing them would tell a legitimate operator to log in
// again for a permission they were never granted.
func TestMissingCapabilityIs403(t *testing.T) {
	w := request(t,
		middleware.RequireBearer(verifierWith([]string{"platform"}), nil),
		middleware.RequireCapability(authcore.CapRotateCredentials),
		"Bearer a.b.c")
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestHeldCapabilityPasses(t *testing.T) {
	w := request(t,
		middleware.RequireBearer(verifierWith([]string{"platform", "rotate-credentials"}), nil),
		middleware.RequireCapability(authcore.CapRotateCredentials),
		"Bearer a.b.c")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

// RequireCapability reached without RequireBearer must refuse. This is the
// fail-closed property: a route group wired in the wrong order denies rather
// than allows.
func TestCapabilityGateWithoutAuthenticationIs401(t *testing.T) {
	w := request(t, middleware.RequireCapability(authcore.CapPlatform), nil, "Bearer a.b.c")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestPrincipalIsAvailableToHandlers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var got authcore.Principal
	var ok bool
	r.GET("/x", middleware.RequireBearer(verifierWith([]string{"platform"}), nil), func(c *gin.Context) {
		got, ok = middleware.BearerPrincipalFrom(c)
		c.Status(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer a.b.c")
	r.ServeHTTP(httptest.NewRecorder(), req)

	if !ok {
		t.Fatal("BearerPrincipalFrom reported no principal")
	}
	if got.Subject != "user-1" {
		t.Errorf("Subject = %q, want user-1", got.Subject)
	}
}
