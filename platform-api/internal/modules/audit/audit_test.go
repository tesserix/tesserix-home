package audit_test

import (
	"net/http"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// The module's Config comment used to WARN that a nil Log panics during an
// outage without doing anything about it. It refuses at wiring time now, the
// way httpx.RegisterModule refuses a nil verifier: the log is only touched on
// the federation failure path, so a nil one survives every happy-path test and
// every healthy day, and turns the first product outage into a panic.
func TestRegisterRefusesANilLogger(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("Register with a nil Log must panic at wiring time — the failure path that dereferences it only runs during an outage")
		}
	}()

	audit.Register(http.NewServeMux(), audit.Config{
		Fed:      federation.NewClient(federation.NewRegistry(nil), nil),
		Slugs:    nil,
		Verifier: &auth.Verifier{},
		Log:      nil,
	})
}
