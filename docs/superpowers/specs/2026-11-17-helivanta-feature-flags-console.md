# Helivanta feature flag control in the platform console

The Tesserix console is the operator interface. GrowthBook remains the private
flag data owner and SDK API; Helivanta remains the release eligibility and
application authorization owner. This integration changes release availability,
not hospital memberships, staff permissions, clinical authority or stock ownership.

## Bounded contract

Add Feature Flags to the platform navigation, with Helivanta as the configured
product. Group its complete declared catalogue into Staff, PharmaConnect,
Foundation and other product areas. Give each control a readable purpose,
provider state, effective state, prerequisites and release eligibility. Read
eligibility and dependencies from Helivanta's canonical manifest on release/prod;
console presentation metadata supplies labels, not a second permission master.

Assume fewer than 100 flags, five concurrent operators, below two reads/second
and one write/minute. Bound provider/catalogue responses to 2 MiB and command
bodies to 4 KiB. Management reads have a five-second budget, never enter
Helivanta's request admission path, and return unavailable rather than fake empty
lists. Provider and catalogue failure close management controls. Existing SDK
refresh/expiry and baseline authentication behavior remain unchanged.

Platform API owns the integration and its command journal. Console browsers
never receive GrowthBook credentials or choose a provider/project/environment.
Only the allowlisted Helivanta production binding is available. Reads require an
operator's platform capability. Writes additionally require manage-feature-flags,
validated on the server and through the console's live capability check.

GET /v1/platform/feature-flags/helivanta returns the declared catalogue, current
provider values, effective dependency closure, a revision fingerprint and recent
commands. POST /v1/platform/feature-flags/helivanta/commands accepts a UUID
idempotency key, flag, desired boolean, expected fingerprint and bounded reason.
Unknown products/flags are 404, missing authority 403, stale/busy state 409,
invalid or ineligible enablement 422 and unavailable dependencies 503. Duplicate
keys replay their durable result only for identical actor/product/payload.

Disabling a prerequisite changes dependent effective availability without
silently rewriting dependent desired values. The confirmation previews this
impact, including features that would resume when prerequisites are restored.
Enabling a feature whose prerequisites are off is refused. Compiled release
eligibility remains a ceiling even if GrowthBook is misconfigured.

## Failure and audit boundaries

Persist attributed intent before provider mutation, then dispatch outside the
Postgres transaction. Permit only one unresolved command per product. Record
success only after observing the provider revision/comment and desired state.
Record uncertain delivery explicitly and block further writes; never blindly
retry a timed-out external mutation. Reconciliation is read-only and may finish
a command only from attributable provider evidence. A command without evidence
stays uncertain for operator investigation; it is not reported as failed or
abandoned. Recovery and ordinary reads preserve history. Journal intent and
outcome audit entries share their respective short database transactions.

GrowthBook is an external write boundary. Its API must preserve publication
checks; no REST approval bypass or arbitrary targeting editor is introduced.
Provider changes outside the console are detected as stale/drift. The dedicated
management credential is scoped to the Helivanta provider, stored in OpenBao,
materialized only to platform-api and never reused as the SDK reader.

## Provisioning and delivery

Provision missing approved flags without overwriting existing console values.
Continue checking project, environment, boolean/default and supported rule shape.
Keep provider frontend running until console/API acceptance. Then run the pinned
GrowthBook supervisor with --only back-end; retain MongoDB, SDK delivery, probes
and retained storage. The rollback is the previous chart command, not deleting
or replacing provider data. No extra datastore or public provider ingress.

A durable journal migration, management credential, role declaration and scoped
network access are part of delivery. Production migration/rollout approval must
name those prepared actions. Local builds and unit tests are allowed; no local
product apps, databases or Docker. Database and browser integration run in CI;
live acceptance uses the shared deployed environment after authorized rollout.


## Recovery and rollout gates

Two recovery commands require both `platform` and `manage-feature-flags`:
`POST /v1/platform/feature-flags/helivanta/commands/{id}/resume` and
`POST /v1/platform/feature-flags/helivanta/commands/{id}/cancel`.
Resume is restricted to the original requester and uses the durable request,
idempotency key and expected revision. Only queued commands dispatch; a resume
of an in-flight, uncertain or terminal command returns its recorded status.
Cancellation atomically changes queued to failed with
`CANCELED_BEFORE_DISPATCH`; it never cancels an already dispatched publication.
The canceling operator is audited separately from the original requester.
Read reconciliation refreshes the snapshot after confirming provider evidence.

Migration `0058_console_feature_flag_commands.sql` and the production rollout
require explicit approval under the repository's cloud rules. The infrastructure
change declares the capability but grants it to nobody automatically. The intended
operator must be verified and explicitly assigned the role. GrowthBook 5.2.1 gates project/environment key restrictions behind its paid
advanced-permissions feature (ApiKeyModel.assertPlanAllowsScope). The management
key is therefore an admin credential confined to the dedicated, single-project
Helivanta provider organization. The console restricts its operations to the fixed
project, production environment and canonical release catalogue. It is not a
provider-enforced project/environment restricted key. It is stored create-only in OpenBao and mounted
only into platform-api; the SDK credential remains separate. A partial key-create /
secret-persist failure stops for recovery rather than rotating or duplicating keys.

GrowthBook remains on the pinned image and Kargo lane. Console-managed seeding
preserves reviewed values; missing flags are seeded, unsupported targeting is
rejected. `apiOnly` is implemented and defaults false. Activate it only after
console/API/SDK and Helivanta UI/API acceptance. It removes the frontend process
and service port while retaining the API, MongoDB, PVCs and API health probes.

Local checks start no applications or databases. Database journal/race tests and
pinned GrowthBook v2 publication/SDK tests execute in CI before image publication.
A successful local build does not establish deployed end-to-end acceptance.
