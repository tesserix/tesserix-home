package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

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

	authHandler := handlers.NewAuth(d.Config, d.Flow, d.Sealer, d.Allow, d.Audit)
	authHandler.Register(r)

	// Everything below this line requires an allowlisted session and, for
	// mutations, a matching CSRF token.
	guarded := r.Group("/",
		middleware.RequireSession(d.Sealer, d.Allow, middleware.SessionCookie(d.Config.IsSecure())),
		middleware.CSRF(),
	)
	guarded.GET("/api/auth/me", authHandler.Me)
	handlers.NewSecrets(d.Secrets, d.Audit).Register(guarded)
	if d.Bao != nil {
		handlers.NewAccess(d.Bao, d.Whitelist, d.Audit).Register(guarded)
	}
	handlers.NewCluster(d.Discovery).Register(guarded)
	handlers.NewWhitelist(d.Whitelist, d.Audit).Register(guarded)
	handlers.NewReviews(d.Reviews, d.Audit).Register(guarded)

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
