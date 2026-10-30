# Staff recovery console acceptance

Status: undeployed candidate; full Access/RBAC A01–A12 remains incomplete.

## Owner and boundary

Identity recovery belongs to `tesserix/onboarding-service` draft PR #22.
The console consumes its exact recovery receipt/source/request/proposal/decision
and reconciliation routes through the existing same-origin provisioning BFF.
There is no browser administrative credential, direct database query, source
account lookup or product-machine impersonation. A platform reader may inspect
and obtain fresh source observations. Writes additionally require current
`rotate-credentials` authority; the identity owner repeats current operator,
product, tenant, command/source and historical reviewer-independence checks.

Receipt models are generated from the owner's Go JSON definitions by
`apps/api/cmd/staff-contracts`. The exact artifact is retained under
`apps/console/lib/provisioning/generated/`; its provenance JSON pins owner
revision and SHA-256. The consumer test verifies the vendored bytes. To update,
regenerate/check in the owner repository, commit the owner artifact, copy that
exact artifact and update its immutable revision/hash together. Do not edit the
consumer models independently.

## Implemented behavior

- Exact tenant/command/request lookup with server-checked console authentication;
  malformed scope sends no request and mismatched receipts disclose no evidence.
- Point-in-time source observation with its timestamp. An unavailable next proof
  clears the old matching display and reconciliation control.
- Proposal entry with required reason/evidence, optional replacement initiator,
  one UUIDv7 request and stable retry key; independent decision entry with explicit
  evidence acknowledgement and one retained successor UUIDv7 when required.
- Server-authoritative reader/maker restrictions, independent approval/rejection
  and matching-account reconciliation. None of these UI results implies Staff
  employment, membership, linking or hospital operational authority.
- Uncertain writes freeze the original input/key. Session-scoped browser storage
  retains only identifiers, action and a canonical payload digest, not private
  reasons/evidence or credentials. Reload requires the original input or a
  matching retained outcome; it never silently selects a new successor/request.
- A matching retained decision resolves a lost response without another write.
  Revoked-operator write denials trigger current reads and hide previously loaded
  evidence when authorization is withdrawn. Pending retry metadata survives.
- All BFF responses/upstream fetches are no-store; CSRF, bounded body and exact
  route/method checks remain active. Read-only POST observation requires CSRF but
  does not incorrectly require a writer capability.

## Automated evidence

TDD reproduced the missing route family, missing public PUT export, absent UI,
uncertain decision/proposal behavior and reconciliation control before delivery.
Further regressions reproduced retained private evidence after a denied write,
acceptance/stripping of a dangling recovery query, rewriting invalid UTF-8 evidence
and misclassifying an unavailable authorization source as a confirmed denial.
Their fixes pass targeted checks; known capability denial is 403 and dependency
unavailability is 503 without forwarding or exposing private driver details. Tests cover wrong tenant, reader/maker restrictions, current source
failure, immutable retry, reload, retained outcomes and successor preservation.

The initial full console run passed 5,565 tests in 295 files. A parallel rerun
hit 10-second setup hook timeouts in six existing database-test files; it did
not pass and 197 tests were not reached. No tests or timeouts were modified.
A bounded full rerun passed all 5,571 tests, followed by all **5,572 tests in
295 files** after the final authorization-outage regression, with no skips.
Typecheck, lint and the final production build pass, including the Staff recovery
route. Staged redacted Gitleaks and diff checks pass. The full run uses
`--maxWorkers=2` to bound local contention; no test skips or timeout changes were
introduced.
The normalized canonical artifact was additionally regenerated/checked, fetched
from its immutable published owner revision and verified byte-for-byte; the
consumer artifact/provenance test passes. Commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r --filter './packages/**' build
pnpm --filter console test:unit --maxWorkers=2
pnpm --filter console typecheck
pnpm --filter console lint
pnpm --filter console build
```

The initial owner generator revision `2530ad2abcf0cc445c81c16b6fbe6c0710bbe56d`
passed full actual-PostgreSQL Go race tests, vet/build/lint, generator/check,
four delivery tests, redacted secret/diff checks and CI 41127791880. Preceding
source-integrated HTTP candidate `17e3dc9` passed CI 41125975313. The artifact-ending correction at `f75bb0e5479446c3a36015516a2bf661aee357a2`
passed generator stale-artifact red/green, generation/check, command-package race
tests, vet/build/lint and redacted secret/diff checks. Exact-head CI 41131295353
passed contracts, Go quality, secret scanning, container contract and API image;
release/deployment jobs were not run.
These are separate evidence from normal browser authentication and HMS acceptance.

## Local browser attempt and handoff

Created a separate synthetic local provider/client/operator and database fixture.
It uses the actual isolated Zitadel 4.15.3 instance, separate console and owner
PostgreSQL databases, the canonical schema-owner revision 325012b / chart 0.3.62,
new random fixture credentials retained privately, and normal sign-in. Development
authentication bypass is explicitly disabled. No production data, credentials,
registration, rollout or existing recipient authenticator was changed.

The first visit exposed a fixture configuration error: its declared public
origin was not local, so unauthenticated middleware selected the production
login host. No credentials were entered there. Setting the fixture's declared
public origin corrected the redirect entirely to local services. The normal
local sign-in then reached its console callback, which Chrome blocked with
`ERR_BLOCKED_BY_CLIENT`. No warning was bypassed and no session was manufactured.
The tab is retained for human handoff under browser-control policy; fixture
configuration, process handles and evidence are private under the authorized
`.helivanta/staff-management-20261027/console-recovery-20261031` directory.
No callback code, passwords, tokens or source payloads belong in this repository.

## Remaining acceptance

Real console callback/token-verifier/session and operator browser acceptance;
normal proposal → different reviewer → retained decision/source reconciliation;
recipient authentication/setup and HMS Staff Admin/Global API consumption;
canonical production registration (owner issue #12); history/activity and profile
correction where required; legacy Staff/link/grant classification; membership,
renewal, suspension/resumption, exit, contract-expiry, rehire and cross-module
cutoff acceptance; release review and deployed QA. No full-area completion,
merge, production migration, rollout, release tag or issue closure is claimed.

Next.js 16.4.1 generated the narrow `apps/console/AGENTS.md` guide pointer during
local startup. Its generator and applicable shipped route/page/server-client
guides were checked; no authentication bypass or deprecated middleware migration
was introduced by this work.
