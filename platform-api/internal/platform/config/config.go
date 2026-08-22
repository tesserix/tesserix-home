// Package config loads the service's environment. Kernel, not a module.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Config is the whole of the service's configuration. Loaded once at startup
// and passed down; nothing reads os.Getenv below this package.
type Config struct {
	Port            string
	Env             string
	Database        Database
	Auth            Auth
	ShutdownTimeout time.Duration
	Federation      *federation.Registry
}

// Auth is the Zitadel wiring (ADR-003 D8).
//
// DEFAULTS TO DISABLED, and that is a deliberate, temporary state.
//
// The service serves /health and /ready and composes no domain modules, so
// there is nothing yet to protect. Defaulting to enabled would mean the
// currently deployed pod — whose chart supplies no ZITADEL_* variables — fails
// to start on the next promotion, trading no security for a broken rollout.
//
// It must flip when the first module lands (#269). The router refuses to
// register a module route while this is off, so that is enforced rather than
// remembered.
type Auth struct {
	Enabled   bool
	Issuer    string
	ProjectID string
}

// Database describes the connection to tesserix-postgres.
//
// The variable names deliberately match the console's — TESSERIX_DB_HOST and
// friends — because this reads the SAME database with the SAME credentials.
// apps/console/lib/db/tesserix.ts states as much in its own header, and the
// secret already exists in the namespace. Inventing a second spelling would
// mean two names for one credential and an inevitable drift between them.
type Database struct {
	Host     string
	Port     string
	User     string
	Password string
	Name     string
	SSLMode  string

	// MaxConns is small on purpose.
	//
	// ADR-003 D2a treats the pool constraint as measured rather than
	// theoretical: ~30 Go services share a small Postgres, and the console runs
	// max 2, written into its code as the reason a suppression check shares its
	// caller's transaction rather than opening a second connection.
	//
	// Starting at 2 makes the migration net-neutral by construction. This
	// service's pool rises as modules land, and the console's falls as its own
	// data layer retires under ADR-003 D7 — so the estate does not pay for both
	// at once. Raising this is a deliberate act with a reason, not a default
	// nobody chose.
	MaxConns int32

	// MinConns is zero so an idle platform API holds nothing. The estate's
	// scarce resource is connections, not connection latency.
	MinConns int32
}

const (
	defaultPort   = "8080"
	defaultDBPort = "5432"
	// The estate's database is tesserix_admin, not tesserix. The console
	// hard-codes the same fallback (apps/console/lib/db/tesserix.ts), and the
	// chart sets TESSERIX_DB_NAME explicitly, so this default only bites
	// locally — where a wrong default means connecting to a database that does
	// not exist, or worse, one that does and is not this.
	defaultDBName          = "tesserix_admin"
	defaultSSLMode         = "require"
	defaultMaxConns        = 2
	defaultShutdownTimeout = 15 * time.Second
)

func env(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

// Load reads the environment and validates it.
//
// It fails loudly rather than starting half-configured. A service that boots
// without database credentials and only discovers it on the first request has
// turned a startup failure — visible in a rollout, blocked by a readiness
// probe — into an intermittent runtime one.
func Load() (Config, error) {
	cfg := Config{
		Port:            env("PORT", defaultPort),
		Env:             env("APP_ENV", "development"),
		ShutdownTimeout: defaultShutdownTimeout,
		Auth: Auth{
			// Opt-OUT, since #269. This was opt-IN while the service composed
			// no modules and there was nothing to protect; the tickets module
			// is the event that comment was waiting for.
			//
			// Flipped rather than removed. Setting it to false is now a
			// request to serve a domain module unauthenticated, which
			// httpx.RegisterModule refuses by panicking at wiring time with a
			// message naming this variable — so the escape hatch still exists
			// and no longer opens onto anything.
			Enabled: env("PLATFORM_API_AUTH_ENABLED", "true") != "false",
			Issuer:  env("ZITADEL_ISSUER", ""),
			// The Platform Console project: both the audience this API requires
			// and the project whose roles it reads. The console already requests
			// `urn:zitadel:iam:org:project:id:{projectId}:aud`, so its tokens
			// carry it and no new Zitadel application is needed.
			ProjectID: env("ZITADEL_PROJECT_ID", ""),
		},
		Database: database(),
	}

	if v := strings.TrimSpace(os.Getenv("TESSERIX_DB_MAX_CONNS")); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n < 1 {
			return Config{}, fmt.Errorf(
				"TESSERIX_DB_MAX_CONNS must be a positive integer, got %q", v)
		}
		cfg.Database.MaxConns = int32(n)
	}

	// One list, checked once, so a half-configured service is told everything
	// that is wrong with it in a single message.
	//
	// The auth variables used to be checked in their own block, ahead of this
	// one, and returned on their own. That was invisible while authentication
	// was opt-in and nothing set the flag; the moment it became opt-out, a
	// deployment missing BOTH its Zitadel settings and its database password
	// was told only about Zitadel, fixed that, and was told about the password
	// on the next attempt. Two rollouts to learn two facts is exactly what
	// this function's doc comment promises not to do.
	var missing []string
	if cfg.Auth.Enabled {
		if cfg.Auth.Issuer == "" {
			missing = append(missing, "ZITADEL_ISSUER")
		}
		if cfg.Auth.ProjectID == "" {
			missing = append(missing, "ZITADEL_PROJECT_ID")
		}
	}
	missing = append(missing, cfg.Database.missing()...)
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}

	reg, err := federation.LoadRegistry(os.Getenv)
	if err != nil {
		return Config{}, err
	}
	cfg.Federation = reg

	return cfg, nil
}

// LoadDatabase reads only the database group.
//
// For the processes that write the estate's data and serve no authenticated
// route — the AI usage ingest today. Load() would refuse to start them for want
// of Zitadel settings they never use, and setting PLATFORM_API_AUTH_ENABLED=false
// to satisfy it would record something untrue about the process: that flag
// means "serve domain modules unauthenticated", and ingest serves none.
func LoadDatabase() (Database, error) {
	db := database()
	if missing := db.missing(); len(missing) > 0 {
		return Database{}, fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}
	return db, nil
}

func database() Database {
	return Database{
		Host:     env("TESSERIX_DB_HOST", ""),
		Port:     env("TESSERIX_DB_PORT", defaultDBPort),
		User:     env("TESSERIX_DB_USER", ""),
		Password: os.Getenv("TESSERIX_DB_PASSWORD"),
		Name:     env("TESSERIX_DB_NAME", defaultDBName),
		SSLMode:  env("TESSERIX_DB_SSLMODE", defaultSSLMode),
		MaxConns: defaultMaxConns,
		MinConns: 0,
	}
}

func (d Database) missing() []string {
	var missing []string
	if d.Host == "" {
		missing = append(missing, "TESSERIX_DB_HOST")
	}
	if d.User == "" {
		missing = append(missing, "TESSERIX_DB_USER")
	}
	if d.Password == "" {
		missing = append(missing, "TESSERIX_DB_PASSWORD")
	}
	return missing
}

// DSN builds the libpq connection string.
//
// The password is interpolated here and this value must never be logged. It is
// returned rather than stored so there is one short-lived copy at startup
// rather than a field on a struct that something later decides to print.
func (d Database) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		d.Host, d.Port, d.User, d.Password, d.Name, d.SSLMode,
	)
}

// String redacts. Config ends up in a startup log line, and a struct that
// prints its own password is how a credential reaches Cloud Logging.
func (d Database) String() string {
	return fmt.Sprintf(
		"postgres://%s@%s:%s/%s?sslmode=%s (max_conns=%d)",
		d.User, d.Host, d.Port, d.Name, d.SSLMode, d.MaxConns,
	)
}
