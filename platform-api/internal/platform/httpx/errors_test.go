package httpx_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

func TestStatusCodeIsNotSerialised(t *testing.T) {
	body, err := json.Marshal(httpx.NotFound("no such ticket"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := decoded["StatusCode"]; present {
		t.Error("StatusCode leaked into the body; the response carries it already")
	}
	if decoded["code"] != httpx.CodeNotFound {
		t.Errorf("want code %q, got %v", httpx.CodeNotFound, decoded["code"])
	}
}

func TestEmptyDetailsAreOmitted(t *testing.T) {
	body, _ := json.Marshal(httpx.BadRequest("bad"))
	if strings.Contains(string(body), "details") {
		t.Errorf("absent details must be omitted, got %s", body)
	}
}

// The property that matters most here: a driver error's text must never reach
// the client. Losing this is how query and schema shape leak.
func TestFromDoesNotLeakTheUnderlyingError(t *testing.T) {
	cause := errors.New(`pq: relation "platform_tickets" does not exist`)

	got := httpx.From(fmt.Errorf("listing tickets: %w", cause))

	if got.StatusCode != http.StatusInternalServerError {
		t.Errorf("want 500, got %d", got.StatusCode)
	}
	if strings.Contains(got.Message, "platform_tickets") ||
		strings.Contains(got.Message, "pq:") {
		t.Errorf("underlying error leaked into the response: %q", got.Message)
	}
}

func TestFromPreservesAnEnvelope(t *testing.T) {
	original := httpx.Conflict("already replied")

	got := httpx.From(fmt.Errorf("handling reply: %w", original))

	if got.Code != httpx.CodeConflict || got.StatusCode != http.StatusConflict {
		t.Errorf("envelope not preserved through wrapping: %+v", got)
	}
	if got.Message != "already replied" {
		t.Errorf("want the original message, got %q", got.Message)
	}
}

func TestFromDefaultsAMissingStatus(t *testing.T) {
	got := httpx.From(httpx.Error{Code: "CUSTOM", Message: "x"})
	if got.StatusCode != http.StatusInternalServerError {
		t.Errorf("a zero status must not become HTTP 0, got %d", got.StatusCode)
	}
}

func TestFromHandlesNil(t *testing.T) {
	got := httpx.From(nil)
	if got.StatusCode != http.StatusInternalServerError {
		t.Errorf("want 500 for a nil error, got %d", got.StatusCode)
	}
}

// Unavailable exists so #198's distinction is expressible: an unreachable
// upstream is not the same as a fault, and a console cannot show "not
// measured" unless the API says which one it hit.
func TestUnavailableIsDistinctFromInternal(t *testing.T) {
	if httpx.Unavailable("x").StatusCode == httpx.Internal("x").StatusCode {
		t.Error("Unavailable and Internal must be distinguishable by status")
	}
	if httpx.Unavailable("x").Code == httpx.Internal("x").Code {
		t.Error("Unavailable and Internal must be distinguishable by code")
	}
}

// The constructors get assigned to package-level sentinels. If WithDetails
// mutated in place, one handler adding a field would edit every future
// response sharing that value.
func TestWithDetailsDoesNotMutateTheReceiver(t *testing.T) {
	base := httpx.Validation("invalid", map[string]any{"field": "status"})

	derived := base.WithDetails(map[string]any{"allowed": "open,closed"})

	if _, leaked := base.Details["allowed"]; leaked {
		t.Error("WithDetails mutated the receiver")
	}
	if derived.Details["field"] != "status" || derived.Details["allowed"] != "open,closed" {
		t.Errorf("derived lost or dropped details: %v", derived.Details)
	}
}

func TestErrorSatisfiesTheErrorInterface(t *testing.T) {
	var err error = httpx.NotFound("gone")
	if err.Error() != "gone" {
		t.Errorf("want the message, got %q", err.Error())
	}
	var target httpx.Error
	if !errors.As(err, &target) {
		t.Error("errors.As must recover the envelope")
	}
}

// Field-for-field compatibility with go-shared's AppError is the reason the
// module is not imported. If these names drift, the justification on #277
// stops being true and a client written against another Tesserix service
// breaks silently.
func TestEnvelopeMatchesTheEstateShape(t *testing.T) {
	body, _ := json.Marshal(httpx.Validation("invalid", map[string]any{"field": "status"}))

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"code", "message", "details"} {
		if _, present := decoded[key]; !present {
			t.Errorf("envelope is missing %q; go-shared's AppError has it", key)
		}
	}
	if len(decoded) != 3 {
		t.Errorf("envelope gained a field go-shared does not have: %v", decoded)
	}
}
