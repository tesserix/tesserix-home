package audit_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/audit"
)

func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &got); err != nil {
		t.Fatalf("audit line is not JSON (%v): %s", err, buf.String())
	}
	return got
}

func TestRecordEmitsActorActionAndTarget(t *testing.T) {
	var buf bytes.Buffer
	log := audit.New(&buf)

	log.Record(audit.Event{
		Actor:   "samyak.rout@gmail.com",
		Action:  audit.ActionSecretDescribe,
		Target:  "homechef/api/db",
		Outcome: audit.OutcomeAllowed,
	})

	got := decode(t, &buf)
	if got["actor"] != "samyak.rout@gmail.com" {
		t.Errorf("actor = %v", got["actor"])
	}
	if got["action"] != "secret.describe" {
		t.Errorf("action = %v, want secret.describe", got["action"])
	}
	if got["target"] != "homechef/api/db" {
		t.Errorf("target = %v", got["target"])
	}
	if got["outcome"] != "allowed" {
		t.Errorf("outcome = %v, want allowed", got["outcome"])
	}
	if got["time"] == nil {
		t.Error("audit line has no timestamp")
	}
}

func TestRecordDeniedIncludesTheReason(t *testing.T) {
	var buf bytes.Buffer
	log := audit.New(&buf)

	log.Record(audit.Event{
		Actor:   "mallory@example.com",
		Action:  audit.ActionSecretDescribe,
		Target:  "homechef/api/db",
		Outcome: audit.OutcomeDenied,
		Reason:  "not on the allowlist",
	})

	got := decode(t, &buf)
	if got["outcome"] != "denied" || got["reason"] != "not on the allowlist" {
		t.Fatalf("denied event = %+v", got)
	}
}

// The audit trail records that a secret was touched, never what it held.
func TestRecordNeverCarriesSecretValues(t *testing.T) {
	var buf bytes.Buffer
	log := audit.New(&buf)

	log.Record(audit.Event{
		Actor:   "samyak.rout@gmail.com",
		Action:  audit.ActionSecretWrite,
		Target:  "homechef/api/db",
		Outcome: audit.OutcomeAllowed,
		Keys:    []string{"password", "user"},
	})

	line := buf.String()
	if !strings.Contains(line, "password") {
		t.Fatal("audit line should name the keys that were written")
	}

	got := decode(t, &buf)
	for _, field := range []string{"value", "values", "data", "secret"} {
		if _, present := got[field]; present {
			t.Errorf("audit event exposes a %q field", field)
		}
	}
}
