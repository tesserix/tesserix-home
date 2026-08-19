package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func discard() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("reached"))
	})
}

func request(t *testing.T, h http.Handler, header string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/tickets", nil)
	if header != "" {
		req.Header.Set("Authorization", header)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAuthenticateAttachesThePrincipal(t *testing.T) {
	var got *Principal
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := FromContext(r.Context())
		if !ok {
			t.Error("the handler should see a principal")
		}
		got = p
		w.WriteHeader(http.StatusOK)
	})

	rec := request(t, Authenticate(verifierFor(validClaims()), discard(), inner), "Bearer "+jwtShaped)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if got == nil || got.Subject != "user-1" {
		t.Errorf("principal not attached: %+v", got)
	}
}

func TestAuthenticateRefusesWithoutAToken(t *testing.T) {
	rec := request(t, Authenticate(verifierFor(validClaims()), discard(), okHandler()), "")

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("want 401, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "reached") {
		t.Error("the handler must not run")
	}
}

func TestAuthenticateRefusesAMalformedHeader(t *testing.T) {
	for _, header := range []string{"Bearer", "Bearer   ", "Basic abc123", jwtShaped} {
		rec := request(t, Authenticate(verifierFor(validClaims()), discard(), okHandler()), header)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%q: want 401, got %d", header, rec.Code)
		}
	}
}

func TestBearerSchemeIsCaseInsensitive(t *testing.T) {
	// RFC 7235 makes the scheme case-insensitive and clients vary.
	for _, header := range []string{"Bearer " + jwtShaped, "bearer " + jwtShaped, "BEARER " + jwtShaped} {
		rec := request(t, Authenticate(verifierFor(validClaims()), discard(), okHandler()), header)

		if rec.Code != http.StatusOK {
			t.Errorf("%q: want 200, got %d", header, rec.Code)
		}
	}
}

// The property that keeps the distinct errors from becoming an oracle: an
// attacker gets one 401 whichever check failed, while the operator gets the
// detail in the log.
func TestTheClientNeverLearnsWhichCheckFailed(t *testing.T) {
	expired := validClaims()
	expired.ExpiresAt = time.Now().Add(-time.Hour)
	wrongAudience := validClaims()
	wrongAudience.Audience = []string{"someone-else"}
	noRoles := validClaims()
	noRoles.Roles = nil

	var bodies []string
	for _, c := range []*Claims{expired, wrongAudience, noRoles} {
		rec := request(t, Authenticate(verifierFor(c), discard(), okHandler()), "Bearer "+jwtShaped)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", rec.Code)
		}
		bodies = append(bodies, rec.Body.String())
	}
	// Also the opaque-token path, which is refused before parsing.
	rec := request(t, Authenticate(verifierFor(validClaims()), discard(), okHandler()), "Bearer opaque-token")
	bodies = append(bodies, rec.Body.String())

	for i, b := range bodies {
		if b != bodies[0] {
			t.Errorf("response %d differs from the first (%q vs %q) — the body distinguishes failure modes", i, b, bodies[0])
		}
		for _, leak := range []string{"audience", "roles", "expired", "JWT", "project"} {
			if strings.Contains(strings.ToLower(b), strings.ToLower(leak)) {
				t.Errorf("response %d leaks %q: %s", i, leak, b)
			}
		}
	}
}

// The other half of the same property: the operator MUST get the detail, or
// the distinct errors were pointless.
func TestTheLogDoesLearnWhichCheckFailed(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	noRoles := validClaims()
	noRoles.Roles = nil

	request(t, Authenticate(verifierFor(noRoles), log, okHandler()), "Bearer "+jwtShaped)

	logged := buf.String()
	if !strings.Contains(logged, "ACCESS token") {
		t.Errorf("the log should name the Zitadel setting to check, got: %s", logged)
	}
}

func TestRefusalsAreJSON(t *testing.T) {
	rec := request(t, Authenticate(verifierFor(validClaims()), discard(), okHandler()), "")

	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("want application/json, got %q", ct)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("refusal must be valid JSON: %v (%s)", err, rec.Body)
	}
	if body["code"] != "UNAUTHORIZED" {
		t.Errorf("want UNAUTHORIZED, got %q", body["code"])
	}
}

func TestRequireCapabilityAllowsAHolder(t *testing.T) {
	h := Authenticate(verifierFor(validClaims()), discard(),
		RequireCapability(CapCRM, discard(), okHandler()))

	rec := request(t, h, "Bearer "+jwtShaped)

	if rec.Code != http.StatusOK {
		t.Errorf("want 200 for a principal holding crm, got %d", rec.Code)
	}
}

func TestRequireCapabilityRefusesANonHolder(t *testing.T) {
	// Holds crm; the route wants hard-delete. #261's orthogonality at the
	// boundary: a surface never confers a verb.
	h := Authenticate(verifierFor(validClaims()), discard(),
		RequireCapability(CapHardDelete, discard(), okHandler()))

	rec := request(t, h, "Bearer "+jwtShaped)

	if rec.Code != http.StatusForbidden {
		t.Errorf("want 403, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "reached") {
		t.Error("the handler must not run")
	}
}

// 401 and 403 must stay distinct: "you are not signed in" and "you are signed
// in and may not do this" send a caller to different places.
func TestUnauthenticatedAndUnauthorisedAreDifferentStatuses(t *testing.T) {
	authenticated := Authenticate(verifierFor(validClaims()), discard(),
		RequireCapability(CapHardDelete, discard(), okHandler()))

	missing := request(t, authenticated, "")
	held := request(t, authenticated, "Bearer "+jwtShaped)

	if missing.Code != http.StatusUnauthorized {
		t.Errorf("no token should be 401, got %d", missing.Code)
	}
	if held.Code != http.StatusForbidden {
		t.Errorf("valid token without the capability should be 403, got %d", held.Code)
	}
}

// A route wired without Authenticate in front of it must refuse, not panic and
// not fall through. The zero Principal holds nothing, so falling through would
// be a route open to everyone.
func TestRequireCapabilityRefusesWhenTheRouteIsNotAuthenticated(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))

	rec := request(t, RequireCapability(CapCRM, log, okHandler()), "Bearer "+jwtShaped)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
	if !strings.Contains(buf.String(), "not authenticated") {
		t.Errorf("the log should name the wiring bug, got: %s", buf.String())
	}
}

func TestFromContextIsAbsentWithoutAuthentication(t *testing.T) {
	if _, ok := FromContext(context.Background()); ok {
		t.Error("a bare context must not yield a principal")
	}
}
