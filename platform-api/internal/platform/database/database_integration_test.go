package database_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/config"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/database"
)

// Integration tests for the pool. They need a real Postgres because what they
// assert — that Open verifies the connection rather than trusting pgx's lazy
// dial, and that Health answers honestly — cannot be observed against a fake.
//
// Skipped when TESSERIX_TEST_DB_HOST is unset, so `go test ./...` stays useful
// on a machine with no database. CI supplies one as a service container, so the
// skip is a developer convenience and not a way for these to quietly never run.
//
// The variables are deliberately TESSERIX_TEST_DB_* rather than the service's
// own TESSERIX_DB_*: a test suite that picks up ambient production credentials
// and then truncates something is a category of accident worth designing out.

func testConfig(t *testing.T) config.Database {
	t.Helper()
	host := os.Getenv("TESSERIX_TEST_DB_HOST")
	if host == "" {
		t.Skip("TESSERIX_TEST_DB_HOST is not set; skipping database integration tests")
	}
	return config.Database{
		Host:     host,
		Port:     envOr("TESSERIX_TEST_DB_PORT", "5432"),
		User:     envOr("TESSERIX_TEST_DB_USER", "postgres"),
		Password: os.Getenv("TESSERIX_TEST_DB_PASSWORD"),
		Name:     envOr("TESSERIX_TEST_DB_NAME", "postgres"),
		SSLMode:  envOr("TESSERIX_TEST_DB_SSLMODE", "disable"),
		MaxConns: 2,
		MinConns: 0,
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func TestOpenConnectsAndHealthAnswers(t *testing.T) {
	cfg := testConfig(t)
	ctx := context.Background()

	pool, err := database.Open(ctx, cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	if err := pool.Health(ctx); err != nil {
		t.Errorf("Health on a live database: %v", err)
	}
}

// Open must reach the database before returning, not merely construct a pool.
// pgxpool dials lazily, so without the ping a misconfigured service starts
// healthy and fails on its first real request — the failure mode config.Load
// is written to avoid, reintroduced one layer down.
func TestOpenFailsWhenTheDatabaseIsUnreachable(t *testing.T) {
	cfg := testConfig(t)
	cfg.Port = "1" // nothing listens here

	start := time.Now()
	pool, err := database.Open(context.Background(), cfg)
	if err == nil {
		pool.Close()
		t.Fatal("Open must fail when the database is unreachable")
	}
	// The ping carries a 5s timeout; allow slack for a slow runner but catch
	// the case where it hangs on the caller's context instead.
	if elapsed := time.Since(start); elapsed > 20*time.Second {
		t.Errorf("Open took %s; the connection check is not bounded", elapsed)
	}
}

// The property the redact unit tests assert in isolation, verified on the path
// that actually produces the error. A wrong password is the case most likely
// to make a driver echo the connection string.
func TestOpenDoesNotLeakThePasswordOnFailure(t *testing.T) {
	cfg := testConfig(t)
	cfg.Password = "wrong-password-that-must-not-appear"

	_, err := database.Open(context.Background(), cfg)
	if err == nil {
		t.Skip("the test database accepts any password; nothing to assert")
	}
	if strings.Contains(err.Error(), "wrong-password-that-must-not-appear") {
		t.Fatalf("the password leaked into the error: %v", err)
	}
}

func TestPoolRespectsItsMaxConns(t *testing.T) {
	cfg := testConfig(t)
	cfg.MaxConns = 2

	pool, err := database.Open(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	// ADR-003 D2a treats this constraint as measured, not theoretical. A pool
	// that silently ignored the setting would undo the argument the modular
	// monolith was chosen on.
	if got := pool.Config().MaxConns; got != 2 {
		t.Errorf("want MaxConns 2, got %d", got)
	}
}

// Health must fail rather than block once the database goes away, or the
// readiness probe reports nothing in the one situation it exists for. Closing
// the pool is the reachable stand-in for the database vanishing.
func TestHealthFailsOnAClosedPool(t *testing.T) {
	cfg := testConfig(t)

	pool, err := database.Open(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	pool.Close()

	start := time.Now()
	if err := pool.Health(context.Background()); err == nil {
		t.Error("Health must fail against a closed pool")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("Health took %s; its own timeout is not bounding it", elapsed)
	}
}
