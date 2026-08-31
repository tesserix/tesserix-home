package middleware_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
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
}

func (s stubParser) Parse(context.Context, string) (*authcore.Claims, error) {
	return s.claims, nil
}

// The platform-console PROJECT, per docs/RUNBOOK-ZITADEL-IDENTITY.md — the
// same value platform-api's handler tests use. Zitadel puts the project id
// in a token's `aud`, which is what Verifier checks.
//
// NOT 386377229942128837: that is the Tesserix ORGANIZATION. Both ids are
// real and both appear in a token, in different positions — the roles claim
// KEY is urn:zitadel:iam:org:project:<projectId>:roles, while the org id
// appears inside the claim VALUE. Using the org id here passed, because the
// same constant supplied both the audience and the expected project, but it
// would mislead anyone comparing it against a production audience mismatch.
const testProject = "386377618200461939"

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
	w := request(t, middleware.RequireBearer(verifierWith([]string{"platform"}), nil), nil, "Basic a.b.c")
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

// The verification-failure branch of RequireBearer is the one whose defect
// hands an unauthorised client the role vocabulary (ErrNoRoles names it). A
// verifier that genuinely refuses — here, a token with no roles — must
// produce the FIXED refusal body, never the underlying error, while the real
// reason still reaches the log so an operator can diagnose it.
func TestVerificationFailureIsLoggedNotLeakedToCaller(t *testing.T) {
	var logBuf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logBuf, nil))

	verifier := authcore.NewVerifier(stubParser{claims: &authcore.Claims{
		Subject:   "user-1",
		Audience:  []string{testProject},
		Roles:     nil, // triggers authcore.ErrNoRoles
		ExpiresAt: time.Now().Add(time.Hour),
	}}, testProject)

	w := request(t, middleware.RequireBearer(verifier, log), nil, "Bearer a.b.c")

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}

	const wantBody = `{"error":"authentication required"}`
	gotBody := strings.TrimSpace(w.Body.String())
	if gotBody != wantBody {
		t.Errorf("body = %q, want %q", gotBody, wantBody)
	}
	if strings.Contains(gotBody, "role") {
		t.Errorf("body leaked the role vocabulary: %q", gotBody)
	}

	if !strings.Contains(logBuf.String(), authcore.ErrNoRoles.Error()) {
		t.Errorf("log = %q, want it to contain the rejection reason %q", logBuf.String(), authcore.ErrNoRoles.Error())
	}
}
