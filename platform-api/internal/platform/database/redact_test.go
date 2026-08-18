package database

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/config"
)

// An internal test rather than a _test package: redact is unexported because
// nothing outside should call it, and the property it guarantees is worth
// asserting anyway. pgx errors sometimes echo the connection string, so this is
// the difference between a failed connection and a credential in Cloud Logging.

func cfg(password string) config.Database {
	return config.Database{
		Host: "10.0.0.1", Port: "5432", User: "platform_api",
		Password: password, Name: "tesserix", SSLMode: "require",
	}
}

func TestRedactRemovesThePassword(t *testing.T) {
	c := cfg("hunter2")
	// The shape pgx produces: the DSN, password and all, inside the message.
	err := fmt.Errorf("failed to connect: %s", c.DSN())

	got := redact(err, c)

	if strings.Contains(got.Error(), "hunter2") {
		t.Fatalf("password survived redaction: %s", got)
	}
	if !strings.Contains(got.Error(), "[REDACTED]") {
		t.Errorf("want a redaction marker, got %s", got)
	}
	// Still diagnosable, or redaction has cost more than it saved.
	if !strings.Contains(got.Error(), "10.0.0.1") {
		t.Errorf("redaction destroyed the useful part: %s", got)
	}
}

func TestRedactHandlesRepeatedOccurrences(t *testing.T) {
	c := cfg("hunter2")
	err := errors.New("connect hunter2 failed, retrying with hunter2")

	got := redact(err, c)

	if strings.Contains(got.Error(), "hunter2") {
		t.Fatalf("a later occurrence survived: %s", got)
	}
	if n := strings.Count(got.Error(), "[REDACTED]"); n != 2 {
		t.Errorf("want 2 redactions, got %d: %s", n, got)
	}
}

// The common case: an error that never mentioned the password. It must come
// back byte-identical and, importantly, still unwrappable — callers use
// errors.Is and errors.As on these.
func TestRedactPreservesAnUnaffectedError(t *testing.T) {
	c := cfg("hunter2")
	sentinel := errors.New("connection refused")
	wrapped := fmt.Errorf("dialing: %w", sentinel)

	got := redact(wrapped, c)

	if got.Error() != wrapped.Error() {
		t.Errorf("message changed: %q vs %q", got, wrapped)
	}
	if !errors.Is(got, sentinel) {
		t.Error("redact broke the error chain for an unaffected error")
	}
}

func TestRedactHandlesNil(t *testing.T) {
	if got := redact(nil, cfg("hunter2")); got != nil {
		t.Errorf("want nil, got %v", got)
	}
}

// An empty password must not turn every character boundary into [REDACTED].
func TestRedactWithNoPasswordIsANoOp(t *testing.T) {
	err := errors.New("connection refused")

	got := redact(err, cfg(""))

	if got.Error() != "connection refused" {
		t.Errorf("empty password mangled the message: %q", got)
	}
}
