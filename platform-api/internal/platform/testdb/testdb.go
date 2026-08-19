// Package testdb gives a test a real, migrated tesserix-postgres.
//
// # Why the real schema and not a hand-written fixture
//
// The substance of a module here is SQL. domain/ holds a handful of rules and
// handler/ holds parsing; everything that can be subtly wrong — a keyset
// predicate, a FILTER clause, a transaction that must not half-land — is in a
// query, and a query is only correct against the schema it will actually run
// on. A fixture written by hand agrees with whatever the author believed the
// schema was on the day they wrote it, which is precisely the belief a test is
// supposed to check.
//
// So this applies apps/web/db/migrations verbatim, in order. Drift between a
// module's SQL and the real schema then fails a test rather than a deploy.
//
// # The path, and its expiry
//
// The migrations live under apps/web because that is where tesserix-postgres
// has always been migrated from — the platform API adopts existing tables
// rather than creating any (see the README: "a module is a Go rewrite of
// queries that already exist"). ADR-003 D1 deletes apps/web eventually, at
// which point the directory moves and this constant moves with it. Recorded so
// the coupling reads as known rather than accidental.
//
// # Credentials
//
// TESSERIX_TEST_DB_*, never the service's own TESSERIX_DB_*. A test suite that
// picks up ambient production credentials and then truncates something is a
// category of accident worth designing out — the same reasoning the pool's own
// integration tests record.
package testdb

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrationsDir is relative to this file's package directory.
const migrationsDir = "../../../../apps/web/db/migrations"

var migrationFile = regexp.MustCompile(`^(\d{4})_.+\.sql$`)

// New returns a pool onto a freshly migrated, empty database of its own.
//
// A database per test, not a shared one with a truncate between tests: these
// tests run with -race and Go runs package tests in parallel, so a shared
// schema turns an ordering bug in the test harness into a flake in whichever
// test lost the race. Creating a database is cheap next to the cost of
// diagnosing that.
//
// Skips when TESSERIX_TEST_DB_HOST is unset, so `go test ./...` stays useful on
// a machine with no database. CI supplies one and fails if these skip there.
func New(t *testing.T) *pgxpool.Pool {
	t.Helper()

	host := os.Getenv("TESSERIX_TEST_DB_HOST")
	if host == "" {
		t.Skip("TESSERIX_TEST_DB_HOST is not set; skipping tests that need a database")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	admin, err := pgxpool.New(ctx, dsn(envOr("TESSERIX_TEST_DB_NAME", "postgres")))
	if err != nil {
		t.Fatalf("connecting to the test server: %v", err)
	}
	defer admin.Close()

	name := databaseName(t)
	// Dropped first so a crashed previous run cannot make this one fail for a
	// reason that has nothing to do with the code under test.
	if _, err := admin.Exec(ctx, `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); err != nil {
		t.Fatalf("dropping %s: %v", name, err)
	}
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatalf("creating %s: %v", name, err)
	}

	pool, err := pgxpool.New(ctx, dsn(name))
	if err != nil {
		t.Fatalf("connecting to %s: %v", name, err)
	}
	if err := migrate(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("migrating %s: %v", name, err)
	}

	t.Cleanup(func() {
		pool.Close()
		// Best effort. A leftover database on a test server costs nothing, and
		// failing a passing test during cleanup would be worse than the mess.
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelCleanup()
		if dropper, err := pgxpool.New(cleanupCtx, dsn(envOr("TESSERIX_TEST_DB_NAME", "postgres"))); err == nil {
			_, _ = dropper.Exec(cleanupCtx, `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
			dropper.Close()
		}
	})

	return pool
}

// databaseName derives a legal, unique identifier from the test's name.
//
// Interpolated into DDL, where a parameter is not accepted — so it is
// restricted to characters that cannot escape an identifier rather than
// quoted and hoped for. Test names are developer-authored, but a name
// containing a quote would produce a confusing syntax error rather than an
// obvious one.
func databaseName(t *testing.T) string {
	var b strings.Builder
	b.WriteString("pa_test_")
	for _, r := range strings.ToLower(t.Name()) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	name := b.String()
	// Postgres truncates identifiers at 63 bytes, which would collide two long
	// test names onto one database. Truncating from the END keeps the part of
	// a Go test name that actually distinguishes it.
	if len(name) > 63 {
		name = name[len(name)-63:]
	}
	return name
}

func dsn(database string) string {
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s",
		envOr("TESSERIX_TEST_DB_USER", "postgres"),
		os.Getenv("TESSERIX_TEST_DB_PASSWORD"),
		os.Getenv("TESSERIX_TEST_DB_HOST"),
		envOr("TESSERIX_TEST_DB_PORT", "5432"),
		database,
		envOr("TESSERIX_TEST_DB_SSLMODE", "disable"),
	)
}

// migrate applies every migration file in version order.
//
// Each runs as one Exec rather than statement by statement: the files contain
// their own BEGIN/COMMIT and multi-statement bodies, and splitting on
// semicolons would break the first function definition that contains one.
func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("reading %s: %w", migrationsDir, err)
	}

	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && migrationFile.MatchString(entry.Name()) {
			files = append(files, entry.Name())
		}
	}
	// Lexical order IS version order: the prefix is zero-padded to four
	// digits, which is what the padding is for.
	sort.Strings(files)
	if len(files) == 0 {
		return fmt.Errorf("no migrations found in %s", migrationsDir)
	}

	for _, name := range files {
		body, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			return fmt.Errorf("reading %s: %w", name, err)
		}
		if _, err := pool.Exec(ctx, string(body)); err != nil {
			return fmt.Errorf("applying %s: %w", name, err)
		}
	}
	return nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
