package featureflags

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Config binds the private Helivanta provider to its platform owner.
type Config struct {
	Pool              *pgxpool.Pool
	Verifier          *auth.Verifier
	Log               *slog.Logger
	ProjectID         string
	ManagementKeyFile string
	HTTPClient        *http.Client
}

// Register serves the approved product catalogue and its audited commands.
func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Verifier == nil || cfg.Log == nil {
		panic("feature flags requires authentication and a logger")
	}
	configured := cfg.ProjectID != "" && cfg.ManagementKeyFile != ""
	p := newProvider(cfg.ProjectID, "", cfg.HTTPClient)
	p.keyFile = cfg.ManagementKeyFile
	s := service{provider: p, journal: journal{pool: cfg.Pool}}
	fail := func(w http.ResponseWriter, r *http.Request, err error) {
		var issue *problem
		var mapped httpx.Error
		switch {
		case errors.As(err, &issue):
			switch issue.Status {
			case 400:
				mapped = httpx.BadRequest(issue.Message)
			case 403:
				mapped = httpx.Forbidden(issue.Message)
			case 404:
				mapped = httpx.NotFound(issue.Message)
			case 409:
				mapped = httpx.Conflict(issue.Message)
			case 422:
				mapped = httpx.Validation(issue.Message, nil)
			default:
				mapped = httpx.Unavailable("Feature flag management is unavailable.")
			}
		case errors.Is(err, errBusy):
			mapped = httpx.Conflict("Another change is unresolved. Review the command history before continuing.")
		case errors.Is(err, errKeyReused):
			mapped = httpx.Conflict("That request key was used for a different change.")
		default:
			mapped = httpx.Unavailable("Feature flag management is unavailable. No new change has been confirmed.")
		}
		httpx.WriteError(w, r, mapped, cfg.Log)
	}
	guard := func(write bool, handler http.HandlerFunc) http.Handler {
		var next http.Handler = handler
		if write {
			next = auth.RequireCapability(auth.CapManageFeatureFlags, cfg.Log, next)
		}
		next = auth.RequireCapability(auth.CapPlatform, cfg.Log, next)
		bounded := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			budget := 10 * time.Second
			if write {
				budget = 20 * time.Second
			}
			ctx, cancel := context.WithTimeout(r.Context(), budget)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
		return auth.Authenticate(cfg.Verifier, cfg.Log, bounded)
	}
	product := func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Cache-Control", "no-store")
		if r.PathValue("product") != "helivanta" {
			httpx.WriteError(w, r, httpx.NotFound("Product not found."), cfg.Log)
			return false
		}
		if r.URL.RawQuery != "" {
			httpx.WriteError(w, r, httpx.BadRequest("Query parameters are not supported."), cfg.Log)
			return false
		}
		if !configured {
			httpx.WriteError(w, r, httpx.NotImplemented("The Helivanta management connection is not configured."), cfg.Log)
			return false
		}
		return true
	}
	mux.Handle("GET /v1/platform/feature-flags", guard(false, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.RawQuery != "" {
			httpx.WriteError(w, r, httpx.BadRequest("Query parameters are not supported."), cfg.Log)
			return
		}
		httpx.WriteData(w, r, 200, []map[string]any{{"id": "helivanta", "name": "Helivanta", "description": "Hospital, Staff and PharmaConnect release controls", "configured": configured}}, cfg.Log)
	}))
	mux.Handle("GET /v1/platform/feature-flags/{product}", guard(false, func(w http.ResponseWriter, r *http.Request) {
		if !product(w, r) {
			return
		}
		v, err := s.read(r.Context())
		if err != nil {
			fail(w, r, err)
			return
		}
		httpx.WriteData(w, r, 200, v, cfg.Log)
	}))
	mux.Handle("GET /v1/platform/feature-flags/{product}/commands", guard(false, func(w http.ResponseWriter, r *http.Request) {
		if !product(w, r) {
			return
		}
		commands, err := s.journal.recent(r.Context())
		if err != nil {
			fail(w, r, err)
			return
		}
		httpx.WriteData(w, r, 200, commands, cfg.Log)
	}))
	mux.Handle("POST /v1/platform/feature-flags/{product}/commands", guard(true, func(w http.ResponseWriter, r *http.Request) {
		if !product(w, r) {
			return
		}
		principal, ok := auth.FromContext(r.Context())
		if !ok {
			httpx.WriteError(w, r, httpx.Unauthorized("Sign in to continue."), cfg.Log)
			return
		}
		var body struct {
			Key              string `json:"key"`
			Enabled          *bool  `json:"enabled"`
			ExpectedRevision string `json:"expected_revision"`
			Reason           string `json:"reason"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || decoder.Decode(new(any)) != io.EOF || body.Enabled == nil {
			httpx.WriteError(w, r, httpx.BadRequest("Provide one valid feature change."), cfg.Log)
			return
		}
		key := r.Header.Values("Idempotency-Key")
		if len(key) != 1 {
			httpx.WriteError(w, r, httpx.BadRequest("Provide one Idempotency-Key."), cfg.Log)
			return
		}
		result, err := s.apply(r.Context(), principal.Subject, key[0], change{Key: body.Key, Enabled: *body.Enabled, ExpectedRevision: body.ExpectedRevision, Reason: strings.TrimSpace(body.Reason)})
		if err != nil {
			fail(w, r, err)
			return
		}
		httpx.WriteData(w, r, commandStatus(result), result, cfg.Log)
	}))
}

func (p *provider) managementKey() (string, error) {
	if p.keyFile == "" {
		return p.key, nil
	}
	file, err := os.Open(p.keyFile)
	if err != nil {
		return "", errProviderUnavailable
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, 8193))
	if err != nil || len(data) > 8192 {
		return "", errProviderUnavailable
	}
	key := strings.TrimSpace(string(data))
	if key == "" || strings.ContainsAny(key, "\r\n") {
		return "", errProviderUnavailable
	}
	return key, nil
}
