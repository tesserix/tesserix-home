# ADR 0059: Staff identity recovery in the operator console

Status: implementation candidate; no rollout or complete Staff acceptance.

The identity owner now has attributable, independently reviewed recovery commands.
The console BFF does not allow these paths and cannot forward PUT. This prevents
normal operators from using the owner workflow. Hospital employment, membership,
links and scoped access remain separate owner decisions.

Extend the existing same-origin provisioning BFF with only the exact registered
recovery routes under a tenant UUID and command UUIDv7: GET receipt/request,
PUT proposal/decision, POST fresh observation/reconciliation. Request IDs are
UUIDv7. No queries, browser credentials, identity headers or arbitrary source URLs
are forwarded. The server-held console token is the only upstream credential.
The owner repeats current human, exact command/tenant/product and source checks.

Every request requires live `platform` capability. Proposal, decision and
reconciliation also require `rotate-credentials`. Fresh observation is a read
expressed as POST: require same-origin CSRF checks but do not elevate its reader
capability. All non-GET requests retain bounded bodies and stable request keys.
Out-of-scope stays 404, missing session 401, capability denial 403, unconfirmed
source/transport 503. Responses and fetches are no-store.

Assets are private staff identity evidence and an operator's server-held token.
Threats include a revoked/reader operator, a cross-site requester and a browser
supplying a forged tenant, reviewer or bearer. Authorize the BFF session and
capability on every call; the owner separately validates scope and derives actors.
The UI must never treat a visible control or a receipt as membership/access.

Use the current provisioning components, explicit command/request resume IDs and
immutable retry input. Keep uncertain writes frozen across retry/reload, never
silently create a new recovery request after a timeout. Review displays maker,
action, evidence, reason and retained decision; source observations show their
observation time rather than imply ongoing eligibility. Approval requires an
independent operator; the owner remains authoritative for historical parties.

Use the owner Go receipt definitions as canonical inputs for generated consumer
models; do not create independent copies of recovery wire models. UI response
binding must reject another tenant/command/request before displaying private facts.

Reuse ADR 0058's envelope (under five peak requests/second, 20:1 read/write,
256 KiB maximum BFF request, 12-second transport deadline). Owner validation uses
narrower field/body rules. Owner traffic and production SLO remain unmeasured;
no new paid service, database or worker is introduced. Source dependency failure
shows unavailable/uncertain state; no fabricated success. Rollback removes the
new console paths without altering retained owner records. No migration is needed.

Acceptance: BFF route/method and capability tests; retained request/decision and
wrong-scope UI tests; typecheck/lint/build; real operator/browser and real-source
acceptance. Existing callback and asserted-token fixtures are separate evidence.
Full A01–A12 employment/membership/cutoff work and production registration #12
remain required. Do not activate an unregistered production product or broaden
hospital administrators into platform operators to make UI tests pass.
