package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/cluster"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/health/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// The module is exercised through its REAL router, its real verifier — only
// the token's signature is faked.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

type api struct {
	handler http.Handler
	t       *testing.T
}

type stubSource struct {
	workloads []cluster.Workload
	databases []cluster.Database
	err       error
}

func (s stubSource) Deployments(_ context.Context) ([]cluster.Workload, error) {
	return s.workloads, s.err
}

func (s stubSource) Databases(_ context.Context) ([]cluster.Database, error) {
	return s.databases, s.err
}

func serveAs(t *testing.T, source stubSource, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives. This composes what
	// cmd/server composes, line for line.
	httpx.RegisterModule(mux, verifier, "health", func(m *http.ServeMux) {
		health.Register(m, health.Config{Source: source, Verifier: verifier, Log: log})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

func (a *api) get(path string) response {
	a.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("GET %s: response is not JSON: %v (%s)", path, err, out.raw)
	}
	return out
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("not a success: %s", r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", r.raw)
	}
	return data
}

var okSource = stubSource{
	workloads: []cluster.Workload{{Name: "console", Desired: 1, Ready: 1}},
	databases: []cluster.Database{{Name: "pg", Instances: 1, Ready: 1, Phase: domain.HealthyPhase}},
}

func TestHealthAnswersTheStateAndItsCounts(t *testing.T) {
	a := serveAs(t, okSource, "read")

	got := a.get("/v1/platform/health")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data := got.data(t)
	if data["state"] != "healthy" {
		t.Errorf("state = %v, want healthy", data["state"])
	}
	if data["stale"] != false {
		t.Errorf("stale = %v, want false", data["stale"])
	}
	if data["checked_at"] == nil || data["checked_at"] == "" {
		t.Error("checked_at is missing — staleness is unreadable without it")
	}
}

func TestAFailedClusterReadIsStillA200Unmeasured(t *testing.T) {
	// NOT a 500. `unmeasured` is a legitimate answer to "how is the estate",
	// and a 500 would make the console's error path — not its unmeasured
	// path — the one that renders, which is a different and less honest UI.
	a := serveAs(t, stubSource{err: errors.New("no route to host")}, "read")

	got := a.get("/v1/platform/health")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 — unmeasured is an answer, not a failure: %s",
			got.status, got.raw)
	}
	if state := got.data(t)["state"]; state != "unmeasured" {
		t.Errorf("state = %v, want unmeasured", state)
	}
}

func TestHealthPutsItemsOnTheWireUnderBothSections(t *testing.T) {
	source := stubSource{
		workloads: []cluster.Workload{{Name: "console", Desired: 2, Ready: 2}},
		databases: []cluster.Database{
			{Name: "tesserix-postgres", Instances: 1, Ready: 1, Phase: domain.HealthyPhase},
		},
	}
	a := serveAs(t, source, "read")

	got := a.get("/v1/platform/health")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data := got.data(t)

	workloads, ok := data["workloads"].(map[string]any)
	if !ok {
		t.Fatalf("workloads is not an object: %s", got.raw)
	}
	workloadItems, ok := workloads["items"].([]any)
	if !ok || len(workloadItems) != 1 {
		t.Fatalf("workloads.items = %v, want one item: %s", workloads["items"], got.raw)
	}
	workloadItem, ok := workloadItems[0].(map[string]any)
	if !ok {
		t.Fatalf("workloads.items[0] is not an object: %s", got.raw)
	}
	if workloadItem["name"] != "console" || workloadItem["desired"] != 2.0 || workloadItem["ready"] != 2.0 {
		t.Errorf("workloads.items[0] = %v, want console 2/2", workloadItem)
	}
	if workloadItem["ok"] != true {
		t.Errorf("workloads.items[0].ok = %v, want true — the row verdict must be on the wire", workloadItem["ok"])
	}

	databases, ok := data["databases"].(map[string]any)
	if !ok {
		t.Fatalf("databases is not an object: %s", got.raw)
	}
	databaseItems, ok := databases["items"].([]any)
	if !ok || len(databaseItems) != 1 {
		t.Fatalf("databases.items = %v, want one item: %s", databases["items"], got.raw)
	}
	databaseItem, ok := databaseItems[0].(map[string]any)
	if !ok {
		t.Fatalf("databases.items[0] is not an object: %s", got.raw)
	}
	if databaseItem["name"] != "tesserix-postgres" || databaseItem["instances"] != 1.0 ||
		databaseItem["ready"] != 1.0 || databaseItem["phase"] != domain.HealthyPhase {
		t.Errorf("databases.items[0] = %v, want tesserix-postgres 1/1 %q", databaseItem, domain.HealthyPhase)
	}
	if databaseItem["ok"] != true {
		t.Errorf("databases.items[0].ok = %v, want true — the row verdict must be on the wire", databaseItem["ok"])
	}
}

func TestTheWireCarriesAFalseVerdictForARowTheSummaryCountsBad(t *testing.T) {
	// The failure this pins: a cluster mid-failover reports MATCHING counts,
	// so anything re-deriving the verdict from counts alone marks the row
	// fine directly under a summary reading "0 / 1". Only the classifier
	// knows, so only the classifier's answer goes on the wire.
	source := stubSource{
		workloads: []cluster.Workload{{Name: "console", Desired: 2, Ready: 2}},
		databases: []cluster.Database{
			{Name: "tesserix-postgres", Instances: 1, Ready: 1, Phase: "Failing over"},
		},
	}
	a := serveAs(t, source, "read")

	data := a.get("/v1/platform/health").data(t)
	databases, ok := data["databases"].(map[string]any)
	if !ok {
		t.Fatalf("databases is not an object: %v", data)
	}
	items, ok := databases["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("databases.items = %v, want one item", databases["items"])
	}
	item, ok := items[0].(map[string]any)
	if !ok {
		t.Fatalf("databases.items[0] is not an object: %v", items[0])
	}
	if item["ok"] != false {
		t.Errorf("databases.items[0].ok = %v, want false — the phase failed it", item["ok"])
	}
	if item["ready"] != 1.0 || item["instances"] != 1.0 {
		t.Errorf("databases.items[0] = %v, want the matching counts preserved", item)
	}
	if databases["ready"] != 0.0 {
		t.Errorf("databases.ready = %v, want 0", databases["ready"])
	}
}

func TestHealthRefusesAnUnknownQueryParameter(t *testing.T) {
	a := serveAs(t, okSource, "read")

	got := a.get("/v1/platform/health?namespace=other")
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 — there is no filtering to ask for", got.status)
	}
}
