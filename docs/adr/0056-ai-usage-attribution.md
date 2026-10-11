# AI usage attribution and partial pricing

The deployed central ledger contains about 960 events (2026-10-11). It already
uses OTLP, durable JetStream delivery and transactional event/hourly writes.
Keep that pipeline. Do not add a second billing service or synchronously wait
for accounting on the model path. Identity fields contain server-stamped user UUIDs and service names. Peak traffic is
not measured; this change does not alter admission limits or request SLOs.

Kora stamps its authenticated database UUID server-side. Its private gateway
requires workload/service authentication and delegates that UUID to agents.
Agent context variables reset after each request. A missing ID means machine
work or missing attribution, never a made-up user. These headers are telemetry,
not an authorization mechanism, and are removed before external provider egress.
The platform-only usage API retains its existing capability check.

Gateway tracing adds `tesserix.user_id` and `tesserix.service` from metadata
captured before provider header removal. Reading request headers at trace export
time loses both values; this was reproduced against the real gateway binary. Non-OpenAI Jev
responses are buffered to 64 KB and reduced to model and token counts in gateway
metadata; prompts, decisions and credentials are not exported. The processor
uses a private, nonrecursive gateway decision route and holds only a gateway
credential. Its workload authorization allows this route specifically; its
public provider egress is removed. JEV gate events use service `token-optimizer`,
with the originating service separately visible in processor event logs.

Events retain nullable user/service fields. Per-user/service breakdowns use the
existing indexed product/time window over raw events, at most 30 days. Existing
hourly aggregates and their replay identity remain unchanged. Raw event retention
still applies; no historical user attribution is fabricated. Monetary columns
use 12 decimal places so a one-token embedding does not round to zero per write.

The dated rate card records public list-price estimates, not invoices or credits.
Known-but-incomplete rates produce `partial`, and absent rates stay `unpriced`.
Requests without measured tokens also remain `unpriced`, including failed calls.
TypeSafe publishes $42/billion input tokens; no output rate was verified, so its
known input subtotal is explicitly partial. Console totals show pricing gaps.
Provider-billed amounts require reconciliation with provider invoices.

Rollout order: apply migrations 0054 and 0055, deploy platform API/ingest, deploy
console, reconcile gateway routes, then deploy Kora/agents and the processor.
Pin every image; do not leave the processor's old image with its new credential.
Run authenticated photo, label, coach and embedding tests and match ledger user,
service, model, token totals and dated prices. Replay an OTLP fixture and verify
one event and one hourly increment. The real v1.4.1 synthetic gateway export is
covered by `TestGatewayDecisionExportReachesPricedLedgerOnce`.

Rollback applications/config by their previous image and Git revision. Keep the
additive columns, expanded precision and rate rows: dropping them would destroy
accounting evidence. Migrations have short lock/statement deadlines and run in
transactions. No automatic backfill guesses missing historical identity/cost.


Verification on 2026-10-11:

- Platform API: `gofmt -l .`, `go vet ./...`, `go build ./...`, and
  `go test -race ./...` passed against local Postgres. `govulncheck ./...`
  reports zero reachable vulnerabilities after updating x/net to v0.60.0.
- Kora API: formatting, vet, build and full race suite passed against local
  Postgres; its vulnerability scan reports zero reachable vulnerabilities.
- Agents: full 406-test suite, Ruff and strict mypy passed (90.86% coverage).
- Processor: full 74-test suite, Ruff and strict mypy passed (91.72% coverage).
  Cloud Build 03cb237d-ea61-49d7-a1b7-2473006f3a0f passed image checks and runtime
  readiness. Its pinned image digest is
  `sha256:fd76ced977d24ac35c685c9ca41e01c35ce17979b06da8749836cd16be9dfc56`.
- Console: full 5,391-test suite passed with `vitest run --maxWorkers=2`;
  an initial unconstrained run hit PGlite setup timeouts. The final 62-test
  AI usage suite, typecheck, lint and production build passed.
- Infra: 33 gateway, 4 attribution, 5 registry and 6 migration tests passed;
  all three changed charts passed Helm lint and generated bundle parity.
  Public audience and DevAI principal assertions fail identically on untouched
  main; these unrelated tests were not weakened.
- Real agentgateway v1.4.1: identity reached ext_proc, was absent from provider
  headers, and survived in exported OTLP metadata. The captured export passes
  a real-Postgres replay test with exactly one ledger event/hourly increment.
- Gitleaks found no secrets in changed source files. A scan of release patches
  flags an unchanged Go checksum context line, not a credential. Broad Trivy
  scans still flag existing dependencies (including shell-quote, urllib3 and
  nltk) and infrastructure configurations; this change is not a clean bill of
  health for the complete repositories.

Production migration, rollout and authenticated production ledger verification
are pending. Platform main publishes an image that can auto-promote, so do not
merge the platform PR before the additive schema is in place. The ingest also
needs an explicit immutable platform API image pin when that release is built.


Remote PR checks add release blockers: ai-agents and token-optimizer jobs could
not start because GitHub reports failed account payments or a spending limit.
Platform CI also fails its existing workspace dependency audit (including
advisories with no patched release) and its platform-auth scan using Go 1.26.8.
The local toolchain is Go 1.27.2, so its zero-reachable result must not be treated
as evidence that the older CI/runtime toolchain is clear. Do not disable or
bypass these scanners. Production verification remains unperformed.
