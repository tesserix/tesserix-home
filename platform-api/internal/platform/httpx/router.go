package httpx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Checker reports whether a dependency is usable right now.
type Checker interface {
	Health(ctx context.Context) error
}

// Router builds the service's HTTP surface.
//
// Modules register onto it in cmd/server; this file owns only what exists
// before any module does — the probes, and the JSON conventions every handler
// inherits.
//
// # Why net/http rather than Gin
//
// A deviation from the estate, and a deliberate one. The other services and
// secret-service use Gin, but since Go 1.22 the standard ServeMux routes on
// method and path pattern ("GET /health") and extracts path values, which is
// the whole of what this service needs today. That is one fewer dependency in
// a service whose entire job is to be the thing everything else depends on.
//
// The trade is middleware: Gin's chain is more convenient than wrapping
// http.Handler by hand, and #278's authentication will want a chain. If that
// turns out to be awkward, moving to Gin is mechanical — handlers here take
// (http.ResponseWriter, *http.Request), which Gin adapts. Worth revisiting when
// the first middleware lands rather than pre-empting it now.
func Router(deps Checker, verifier *auth.Verifier, log *slog.Logger) *http.ServeMux {
	mux := http.NewServeMux()

	// The guard that stops "authentication disabled" outliving its purpose.
	//
	// A nil verifier is legitimate ONLY while this router serves probes alone.
	// The moment a module is registered here, a nil verifier means an
	// unauthenticated domain API — so registering one must go through
	// `module()` below, which refuses.
	_ = verifier

	// Liveness: is the process running and able to serve?
	//
	// It deliberately does NOT touch the database. A liveness probe that fails
	// when a dependency is down asks Kubernetes to restart a process that is
	// working correctly, and restarting it will not bring the database back —
	// it just removes the pod that could have served the requests not needing
	// the database, and adds restart churn to an incident.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"}, log)
	})

	// Readiness: should this pod receive traffic?
	//
	// This one does check the database, which is the whole distinction. A pod
	// that cannot reach Postgres can serve nothing useful, so it should leave
	// the load-balancer rotation without being killed.
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		if err := deps.Health(r.Context()); err != nil {
			log.ErrorContext(r.Context(), "readiness check failed", slog.Any("error", err))
			// Unavailable, not Internal — the same distinction #198 exists
			// for. Nothing is broken; a dependency is unreachable.
			WriteError(w, Unavailable("database is not reachable"), log)
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"}, log)
	})

	return mux
}

// WriteJSON writes a value as JSON.
//
// The encode happens into a buffer first. Encoding straight to the
// ResponseWriter commits the status code before it can fail, so a marshalling
// error mid-write produces a 200 with a truncated body — a corrupt success,
// which is worse than an honest 500.
func WriteJSON(w http.ResponseWriter, status int, body any, log *slog.Logger) {
	encoded, err := json.Marshal(body)
	if err != nil {
		log.Error("encoding response failed", slog.Any("error", err))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":"INTERNAL_SERVER_ERROR","message":"request failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(encoded); err != nil {
		// The client is gone. Nothing to do but record it — the status is
		// already sent, so there is no error to return.
		log.Debug("writing response failed", slog.Any("error", err))
	}
}

// WriteError writes the envelope for err at its own status.
func WriteError(w http.ResponseWriter, err error, log *slog.Logger) {
	envelope := From(err)
	WriteJSON(w, envelope.StatusCode, envelope, log)
}

// RegisterModule registers a domain module's routes, refusing to do so without a
// verifier.
//
// This is the enforcement behind config.Auth's comment that authentication
// "must flip when the first module lands". Left to a checklist it would be
// forgotten exactly once, and the failure — a domain API serving anyone who can
// reach the port — is silent.
//
// It panics rather than returning an error because there is no recovery: a
// service that cannot authenticate the module it is about to serve should not
// start, and this runs at wiring time, not per request.
func RegisterModule(mux *http.ServeMux, verifier *auth.Verifier, name string, register func(*http.ServeMux)) {
	if verifier == nil {
		panic("refusing to register module " + name +
			" with authentication disabled — set PLATFORM_API_AUTH_ENABLED=true")
	}
	register(mux)
}
