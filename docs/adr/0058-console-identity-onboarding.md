# ADR 0058: Identity onboarding in the console

Status: Accepted for implementation; production cutover requires verification.

## Context and constraints

The separate onboarding web application duplicates operator login and navigation.
The console already owns platform operator sessions and stores access tokens only
on the server. Its existing onboarding funnel reports product signups; it does
not provision identity. The provisioning API owns its database, durable audit,
private identity claims and exact namespace-bound activation contracts.

Planning envelope (assumptions, not measured traffic): under 1 mutation/second at
peak, request bodies at most 256 KiB, reads:writes 20:1, under 10,000 onboarding
records in 12 months / 30,000 in 36 months. Use the existing capacity. Target
99.9% control-plane availability, p99 acceptance under 2 seconds and bounded
12-second proxy requests; asynchronous reconciliation can take longer and must
report pending. No new database, queue or reconciliation engine is needed.

## Decision

Serve `/platform/provisioning` in `apps/console`, with product registration,
tenant creation/adoption, Helivanta provisioning/resume, organization management
and audit. Keep signup funnel reporting at `/platform/onboarding`.

A same-origin `/api/onboarding/*` BFF allowlists routes/methods, bounds requests,
requires a console session and live platform capability, and sends only the
server-held operator access token to a configured private API origin. Writes
also require `rotate-credentials`; deletion/deactivation requires `hard-delete`.
Stable request keys and upstream 404/409 responses survive the hop. No browser
bearer, cookie, caller identity header or upstream URL is forwarded.

The API independently verifies issuer, RS256, expiry, console project audience,
exact OAuth client and roles granted in the platform org for that project.
`platform` maps to a reader; adding `rotate-credentials` permits administrative
writes. Deletion/deactivation additionally needs `hard-delete`. The real human
subject remains the actor in the existing durable audit and idempotency scope.
This keeps product machine audiences and authorization separate.

Assets at risk are org ownership, tenant memberships, federation configuration,
credentials and retained customer bindings. Attackers include other products,
other tenants, a revoked operator and cross-origin browser requests. Both BFF
and API authorize the credential at their trust boundaries; untrusted IDs never
define caller scope. API authorization remains authoritative when console grants
or display state are stale. Revocation remains bounded by access-token validity;
the existing console live-capability refresh narrows this window, not eliminates it.

Retain the provisioning API's database and workload identity in its current
namespace. Consolidating it into platform-api now would move data ownership and
namespace-bound identities without improving this UI migration. An iframe/link
to the old app is rejected because it retains the separate login and origin.

## Failures, migration and recovery

An unavailable API or token store reports unavailable; no machine credential
fallback. A timeout has an uncertain outcome: resume or replay the same intent
with the same key. Claims reconcile forward across dependency outages and Ready
requires activation plus the held receipt. Changed payloads remain conflicts;
foreign product/customer reads remain denied by the API. No new compensations
or customer deletions are introduced.

Deploy console-compatible API auth first, then the console and private network
path. Verify product listing/registration, authorized tenant onboarding/adoption,
status/resume, actor attribution, negative auth/CSRF tests, replay and baseline
identity/archive stability. Switch external machine consumers to the console's
API ingress with their original bearer semantics. Capture old GitOps/DNS state,
then retire its public hostname, old frontend and obsolete delivery resources.
Keep DB/schema, identities, OpenBao secrets and held records. Before retirement,
rollback is the previous console release; afterward reintroduce the captured
routing/frontend through GitOps if necessary. Never roll back tenant state.

Expected infrastructure cost decreases by removing two frontend replicas; the
existing two API replicas and storage remain. Existing control-plane health/error
monitoring covers the retained API. A backup or idempotent replay is not a proven
full restore: retain the existing recovery procedures and evidence requirements.
