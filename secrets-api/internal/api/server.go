package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	authcore "github.com/tesserix/tesserix-home/platform-auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api/handlers"
	"github.com/tesserix/tesserix-home/secrets-api/internal/api/middleware"
	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
	"github.com/tesserix/tesserix-home/secrets-api/internal/auth"
	"github.com/tesserix/tesserix-home/secrets-api/internal/bao"
	"github.com/tesserix/tesserix-home/secrets-api/internal/config"
	"github.com/tesserix/tesserix-home/secrets-api/internal/k8s"
	"github.com/tesserix/tesserix-home/secrets-api/internal/secrets"
)

type Deps struct {
	Config config.Config
	Flow   *auth.Flow
	Sealer *auth.Sealer
	Allow  *auth.Allowlist
	// Bao is nil when the OpenBao backend is not enabled; namespace access
	// control is then unavailable, since it is an OpenBao policy.
	Bao     *bao.Client
	Secrets *secrets.Registry
	Audit   *audit.Logger
	Log     *slog.Logger
	// Discovery is nil when the API runs outside a cluster; the console then
	// shows no namespaces rather than failing to start.
	Discovery *k8s.Discoverer
	// Whitelist is nil without a GitHub token; proposals are then refused.
	Whitelist handlers.Proposer
	// Reviews is nil on the same terms: with no repository there is nothing to
	// review, approve or merge.
	Reviews handlers.Reviewer
	// Verifier validates Zitadel bearer tokens for the middleware that guards
	// the API surface as it moves off session cookies.
	Verifier *authcore.Verifier
}

func NewRouter(d Deps) *gin.Engine {
	if d.Config.Environment != "development" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(gin.Recovery(), middleware.RequestID(), middleware.SecurityHeaders(), middleware.Logger(d.Log))
	r.Use(cors.New(cors.Config{
		AllowOrigins:     d.Config.AllowedOrigins,
		AllowMethods:     []string{http.MethodGet, http.MethodPut, http.MethodPost, http.MethodDelete},
		AllowHeaders:     []string{"Content-Type", middleware.CSRFHeaderName, middleware.RequestIDHeader},
		AllowCredentials: true,
	}))

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/readyz", func(c *gin.Context) {
		if d.Bao != nil {
			if err := d.Bao.Health(c.Request.Context()); err != nil {
				c.JSON(http.StatusServiceUnavailable, gin.H{"status": "openbao unavailable"})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})

	// Everything below requires a verified Zitadel token. The two groups differ
	// only in the capability they demand.
	//
	// The split follows EFFECT, not HTTP verb. POST /api/access/grants looks
	// like a proposal and is not: CreateGrant writes OpenBao immediately and
	// then opens a pull request to record what it already did. Gating by method
	// would have put that in the same tier as /api/access/whitelist, which
	// really does nothing until a human merges it.
	authed := r.Group("/",
		middleware.RequireBearer(d.Verifier, d.Log),
		middleware.RequireCapability(authcore.CapPlatform),
	)

	// Routes that change live state — OpenBao, Google Secret Manager, or a
	// merge into tesserix-k8s — additionally need the credential verb.
	live := authed.Group("/", middleware.RequireCapability(authcore.CapRotateCredentials))

	handlers.NewSecrets(d.Secrets, d.Audit).Register(authed, live)
	if d.Bao != nil {
		handlers.NewAccess(d.Bao, d.Whitelist, d.Audit).Register(authed, live)
	}
	handlers.NewCluster(d.Discovery).Register(authed)
	handlers.NewWhitelist(d.Whitelist, d.Audit).Register(authed)
	handlers.NewReviews(d.Reviews, d.Audit).Register(authed, live)

	return r
}

func NewServer(d Deps) *http.Server {
	return &http.Server{
		Addr:              fmt.Sprintf(":%d", d.Config.Port),
		Handler:           NewRouter(d),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}
