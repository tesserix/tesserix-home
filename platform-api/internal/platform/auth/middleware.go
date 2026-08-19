package auth

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
)

type contextKey struct{}

var principalKey contextKey

// FromContext returns the principal a request was authenticated as.
//
// The bool is not decoration: a handler reached without authentication has no
// principal, and code that assumed one would authorise against a zero value
// holding no capabilities. Failing to find one is a programming error, and
// RequireCapability treats it as a refusal rather than a panic.
func FromContext(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey).(*Principal)
	return p, ok
}

// Authenticate verifies the bearer token and attaches the principal.
//
// It does NOT authorise. Separating the two is what lets a handler say which
// capability it needs, rather than inheriting whatever the middleware decided —
// the same mistake #261 spent an issue undoing on the console side, where 11 of
// 14 mutations inherited the weakest gate by saying nothing.
func Authenticate(v *Verifier, log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, ok := bearerToken(r)
		if !ok {
			// No token at all is not a misconfiguration worth a loud log — it is
			// an unauthenticated request, which is routine on a public port.
			unauthorized(w)
			return
		}

		principal, err := v.Verify(r.Context(), raw)
		if err != nil {
			// The DISTINCT error goes to the log; the caller gets one 401.
			//
			// Both halves matter. A caller learning which check failed can
			// probe for a valid audience or enumerate role names. An operator
			// reading the log needs exactly that detail, because the difference
			// between "opaque token" and "no roles" is the difference between
			// two different Zitadel settings.
			log.WarnContext(r.Context(), "token rejected",
				slog.String("error", err.Error()),
				slog.String("path", r.URL.Path),
			)
			unauthorized(w)
			return
		}

		ctx := context.WithValue(r.Context(), principalKey, principal)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireCapability refuses a request whose principal lacks `required`.
//
// ADR-003 D8 and #269: the API is the authorisation boundary, and the console's
// checks are UX on top of it. If this service authorised only "is this a valid
// token", anything holding a session could call any module directly and every
// console restriction would be decoration.
func RequireCapability(required Capability, log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := FromContext(r.Context())
		if !ok {
			// Reached without Authenticate in front of it. A wiring bug, and
			// refused rather than panicked: a 403 in production beats a crashed
			// request, and the log says which route is mis-wired.
			log.ErrorContext(r.Context(), "capability check with no principal — route is not authenticated",
				slog.String("path", r.URL.Path),
				slog.String("required", string(required)),
			)
			forbidden(w)
			return
		}

		if !principal.Has(required) {
			// #265 will want this as a recorded denial rather than a log line.
			log.InfoContext(r.Context(), "capability denied",
				slog.String("subject", principal.Subject),
				slog.String("required", string(required)),
				slog.String("path", r.URL.Path),
			)
			forbidden(w)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// bearerToken pulls the token out of the Authorization header.
//
// Case-insensitive on the scheme, because RFC 7235 says the scheme is
// case-insensitive and clients vary.
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

// The two refusals are written here rather than through httpx to keep this
// package free of a dependency on it — auth is the more fundamental of the two,
// and a cycle between kernel packages is the kind of thing that only shows up
// once a third one needs both.
func unauthorized(w http.ResponseWriter) {
	writeRefusal(w, http.StatusUnauthorized, "UNAUTHORIZED", "authentication required")
}

func forbidden(w http.ResponseWriter) {
	writeRefusal(w, http.StatusForbidden, "FORBIDDEN", "you do not hold the capability this action requires")
}

func writeRefusal(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// Hand-written rather than marshalled: neither value is caller-controlled,
	// so there is nothing to escape and nothing that can fail mid-write.
	_, _ = w.Write([]byte(`{"code":"` + code + `","message":"` + message + `"}`))
}
