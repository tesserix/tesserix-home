// Package aiusage is the platform API's AI cost and token usage module.
//
// # What it is
//
// The read side of the estate's AI ledger. Every product's LLM traffic goes
// through one agentgateway data plane, which is the only place that sees
// provider, model, token counts, guardrail verdicts and rate-limit rejections
// for all of them at once. Ingest lands that stream in `ai_usage_events` and
// `ai_usage_hourly` (migration 0030); this module answers questions about it.
//
// It is NOT a billing ledger. Kora's own `ai_usage_events` remains the billing
// authority (tesserix-k8s/docs/kora-ai-gateway.md); these numbers are what the
// gateway observed, and the two differ by exactly the traffic the gateway
// refused before it reached a provider.
//
// # Its routes
//
//	GET /v1/ai/usage/summary      window totals and their shape over time
//	GET /v1/ai/usage/breakdown    one axis: product, provider, model, capability, gateway
//	GET /v1/ai/usage/guardrails   which prompt-guard rules fired, and on whose traffic
//	GET /v1/ai/usage/events       the newest requests, as the gateway saw them
//
// Every route gates on `platform` and the module has no write verb: the gateway
// is the only writer, and an operator editing what a request cost is the thing
// an audit trail exists to make impossible.
//
// # It imports no other module
//
// Only the kernel — httpx, auth — and its own internals.
package aiusage

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/handler"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
)

// Config is what the module needs from the composition root.
type Config struct {
	Pool     *pgxpool.Pool
	Verifier *auth.Verifier
	Log      *slog.Logger
}

// Register mounts the module's routes. Called through httpx.RegisterModule,
// which is what enforces the verifier.
func Register(mux *http.ServeMux, cfg Config) {
	handler.New(service.New(cfg.Pool), cfg.Log).Routes(mux, cfg.Verifier)
}
