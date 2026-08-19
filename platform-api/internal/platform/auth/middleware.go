package auth

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid"
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
			unauthorized(w, r)
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
			unauthorized(w, r)
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
			forbidden(w, r)
			return
		}

		if !principal.Has(required) {
			// #265 will want this as a recorded denial rather than a log line.
			log.InfoContext(r.Context(), "capability denied",
				slog.String("subject", principal.Subject),
				slog.String("required", string(required)),
				slog.String("path", r.URL.Path),
			)
			forbidden(w, r)
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
// package free of a dependency on it — httpx builds the router and therefore
// imports auth, so the reverse edge would be a cycle.
//
// They still have to produce the SAME envelope httpx does. A 401 shaped
// differently from every other failure is the response a client is least able
// to anticipate, because it is the one it meets before it has parsed anything
// else. httpx.TestRefusalsMatchTheAuthPackage asserts the two agree, from the
// side that can see both.
func unauthorized(w http.ResponseWriter, r *http.Request) {
	writeRefusal(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "authentication required")
}

func forbidden(w http.ResponseWriter, r *http.Request) {
	writeRefusal(w, r, http.StatusForbidden, "FORBIDDEN", "you do not hold the capability this action requires")
}

// refusal mirrors httpx.StandardResponse for the two bodies this package
// writes. Declared rather than hand-concatenated: the envelope now nests, and
// a hand-built nested JSON string is a quoting bug waiting for the first
// message that contains one.
//
// Marshalled through encoding/json for the same reason. Neither the code nor
// the message is caller-controlled, but the request id IS — reqid bounds and
// screens it, and marshalling means this code does not have to trust that.
type refusal struct {
	Success   bool           `json:"success"`
	Error     refusalDetails `json:"error"`
	Timestamp time.Time      `json:"timestamp"`
	RequestID string         `json:"request_id,omitempty"`
}

type refusalDetails struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeRefusal(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	body, err := json.Marshal(refusal{
		Success:   false,
		Error:     refusalDetails{Code: code, Message: message},
		Timestamp: time.Now().UTC(),
		RequestID: reqid.FromContext(r.Context()),
	})
	if err != nil {
		// Unreachable: every field is a string, a bool or a time. Handled
		// anyway because the alternative is writing a 200 with an empty body
		// on a path whose entire job is to refuse.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"success":false,"error":{"code":"` + code + `","message":"` + message + `"}}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
