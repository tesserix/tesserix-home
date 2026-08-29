package outbox_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// Register refuses at wiring time, the way httpx.RegisterModule refuses a
// nil verifier, and for the same reason the audit module does: the service
// calls cfg.Log only on the federation failure path, so a nil logger
// survives every happy-path test and every healthy day, and turns the first
// product outage into a panic.
func TestRegisterRefusesANilLogger(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("Register with a nil Log must panic at wiring time — the failure path that dereferences it only runs during an outage")
		}
	}()

	outbox.Register(http.NewServeMux(), outbox.Config{
		Fed:      federation.NewClient(federation.NewRegistry(nil), nil),
		Slugs:    nil,
		Verifier: &auth.Verifier{},
		Log:      nil,
	})
}
