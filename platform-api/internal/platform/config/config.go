// Package config loads the service's environment. Kernel, not a module.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the whole of the service's configuration. Loaded once at startup
// and passed down; nothing reads os.Getenv below this package.
type Config struct {
	Port            string
	Env             string
	Database        Database
	ShutdownTimeout time.Duration
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
	defaultPort            = "8080"
	defaultDBPort          = "5432"
	defaultDBName          = "tesserix"
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
		Database: Database{
			Host:     env("TESSERIX_DB_HOST", ""),
			Port:     env("TESSERIX_DB_PORT", defaultDBPort),
			User:     env("TESSERIX_DB_USER", ""),
			Password: os.Getenv("TESSERIX_DB_PASSWORD"),
			Name:     env("TESSERIX_DB_NAME", defaultDBName),
			SSLMode:  env("TESSERIX_DB_SSLMODE", defaultSSLMode),
			MaxConns: defaultMaxConns,
			MinConns: 0,
		},
	}

	if v := strings.TrimSpace(os.Getenv("TESSERIX_DB_MAX_CONNS")); v != "" {
		n, err := strconv.ParseInt(v, 10, 32)
		if err != nil || n < 1 {
			return Config{}, fmt.Errorf(
				"TESSERIX_DB_MAX_CONNS must be a positive integer, got %q", v)
		}
		cfg.Database.MaxConns = int32(n)
	}

	var missing []string
	if cfg.Database.Host == "" {
		missing = append(missing, "TESSERIX_DB_HOST")
	}
	if cfg.Database.User == "" {
		missing = append(missing, "TESSERIX_DB_USER")
	}
	if cfg.Database.Password == "" {
		missing = append(missing, "TESSERIX_DB_PASSWORD")
	}
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}

	return cfg, nil
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
