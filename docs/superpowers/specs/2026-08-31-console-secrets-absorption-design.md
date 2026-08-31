# Absorbing the secrets surface into the console

**Status:** design, approved in conversation 2026-08-31
**Implements:** ADR-003 D3 · tesserix-home#274 (M4-2)
**Depends on:** #273 (criteria 1 and 6 landed as secret-service#18; criterion 4 to follow)
**Supersedes premises in:** #274 ("the service holds no permission to merge" — false, see §2)

## 1. What moves, and what does not

`secret-service.tesserix.app`, its separate Google login, its repository, its
deploy pipeline and its review queue all retire. The three screens — secrets
browser with inspector, namespace access, review queue — become console sections.

**The backend stays a separately-deployed service with its own service account.**
It holds a GitHub credential able to write across `tesserix-k8s`, OpenBao write
access and cluster RBAC; in one process with the platform API, a defect anywhere
would share an address space with those. One console, many independently
privileged backends — the unification is in the presentation.

The console reaches it through a route handler on the console's own origin, so
the session cookie stays first-party and CORS never enters the design.

## 2. The finding that reshaped this design

#274 asserts two-person integrity holds because *"the service holds no
permission to merge."* **That is false.** Verified 2026-08-31 against the live
deployment:

```
secret-service-api → GITHUB_TOKEN
  login: Sam123ben          type: User        (a personal PAT, not a machine account)
  tesserix-k8s permissions: admin=true maintain=true push=true pull=true
```

The service also has the code path: `GitHub.Merge` issues `PUT /pulls/{n}/merge`,
wired to `POST /api/reviews/:number/merge`.

`tesserix-k8s` `main-protection` permits `RepositoryRole 5 (admin)` to bypass via
pull request (narrowed from unconditional on 2026-08-31, #313). Four PRs were
merged that way during that session, each `BLOCKED / REVIEW_REQUIRED`.

**So propose-and-merge by one person is already possible, ungated and
unlabelled.** This design does not weaken two-person integrity; it replaces an
implicit capability with an explicit, audited one.

A second defect rides along: the credential is **a named individual's personal
token**. Every service action is attributed to that person, carries their full
admin rights rather than scoped ones, and breaks if they rotate it or leave.
Tracked separately — it is true regardless of this design.

## 3. Authorisation model

One question decides everything: **can this actor approve?**

| actor | behaviour |
|---|---|
| holds the approve capability | proposal is merged immediately, audited as auto-approved |
| does not hold it | proposal queues; any holder may approve it in the console |

Self-approval needs no rule because it cannot arise. An actor who can approve
never needs the queue; one who cannot, cannot approve their own. Requiring a
holder to click "approve" on their own proposal would be ceremony that proves
nothing, since they could approve it in the next click regardless.

With two platform admins today, either clears the other's work and a new member's
proposals wait for one of them. The model does not change as the team grows —
only who holds the capability.

**Capability:** reuse `rotate-credentials` rather than minting a new key. It
already denotes authority over live credentials, which is exactly what a
whitelist grant confers. #244's propose/approve split may later separate them;
this design does not pre-empt that.

## 4. What this inverts, and what it makes load-bearing

Approving in the console moves the authorisation decision **from GitHub branch
protection into application code**. Whoever clicks approve, the service's
credential performs the merge. Two consequences must be designed for, not
discovered:

**The Git audit trail stops being true.** Every merge is attributed to the token
holder. The console's audit log becomes the only faithful record of who
authorised what, so it must capture proposer, approver and which path was taken.
The pull request body names both, so the Git history is not purely fictional.
This is the strongest argument for the scoped machine identity in §2 — with it,
Git says `secret-service-bot` rather than falsely implicating a person.

**The console's approval check becomes a top-consequence control.** A defect in
it is arbitrary write access to the repository governing the cluster. It gets the
platform API's treatment: refuse by default, no fallback that silently allows,
and tested at the verb rather than trusted from the surface.

It also makes #285 a dependency rather than a coincidence. Revoking someone's
approval capability is now the only thing standing between them and a merge, and
until 2026-08-31 that took up to seven days to take effect. It now takes five
minutes.

## 5. The user flow

The current "New secret" dialog fuses two unrelated things: whitelisting an app
in Git (a proposal, reviewed, eventually merged) and writing a KV secret
(immediate, authoritative). Its button says "Continue" while its own copy admits
*"Nothing is stored until you write a version with its keys"* — and it opens the
inspector on a path that does not exist.

**Secret creation completes on its own and is true when it says so.**

1. **Create secret** writes the KV version. It touches Git not at all. When the
   screen says the secret exists, it exists.
2. The success state then offers *"grant an app access to this?"* as a clearly
   optional next step, which is the whitelist proposal — a separate action with
   its own outcome.
3. **A secret no app can read is flagged wherever it is listed**, derived from
   whether a whitelist entry exists — not from whether someone finished a wizard.

The derived indicator is the reason this beats a guided two-stage flow. A wizard
only knows about secrets made through the wizard; a derived state also catches a
secret orphaned by a rejected proposal, a later revocation, or a hand-made entry.
It also leaves the common cases untaxed: rotating a secret for an
already-whitelisted app, and granting an existing secret to another app, never
involve creating a secret at all.

## 5a. Notifying the people a proposal is waiting on

A queued proposal blocks two people: whoever can clear it, and whoever raised it
and is waiting to deploy. Both are notified through the console's existing bell
(`components/nav/notification-bell.tsx`, fed by `/api/notifications`) rather than
a second inbox.

| kind | goes to | says |
|---|---|---|
| `access_proposal_open` | holders of `rotate-credentials` | someone needs you to unblock them |
| `access_proposal_merged` | the proposer | your request is live |

The second direction is not a courtesy. Without it a new member reloads the
Reviews page to discover whether they are unblocked — which is exactly the
polling the bell exists to remove.

### Two changes this forces, both of which are the point

**The feed becomes per-capability filtered, not single-gated.** `authorize()`
currently requires `support`, with the reason recorded in place: *"the bell's
feed is ticket and reply rows, so it carries support data."* That reason stops
holding the moment the feed carries a second kind answering to a different
capability. Keeping one gate produces both failures at once — a `support` holder
sees approvals they cannot act on, and someone holding `rotate-credentials` but
not `support` is refused the whole feed and never sees them.

So entry to the feed drops to console entry, and **each kind is filtered by the
capability that kind answers to**. A notification the recipient cannot act on is
noise, and noise in a bell is how people learn to ignore it.

**`NotificationItem` becomes a discriminated union on `kind`.** It is ticket-shaped
today — `ticketId`, `ticketNumber`, `productId` and `subject` are all required —
and an access proposal has none of them. Widening every field to optional would
push the shape check into each renderer; a union keeps the boundary honest, and
`isNotificationFeedShape` already exists to enforce it.

### What this inherits from #285

`/api/notifications` already calls `checkOperatorCapabilityLive`. So revoking
someone's `rotate-credentials` stops their approval notifications within five
minutes rather than up to seven days — the same property §4 relies on for the
approve action itself, arriving here for free rather than needing its own
mechanism.

## 6. Security properties that must survive, each with a test or a note

Carried from #274, verified there from code and cluster config:

- No endpoint returns a secret value; there is deliberately no `secret.read` audit action
- Audit records who, what, path and **key names** — never values
- Backend errors never reach the client: text to the audit log, a generic message to the response
- Write CAS (`ifVersion`) so a second administrator's write is not silently clobbered
- Destroy requires typing the secret name
- Wildcard ServiceAccounts refused; isolation is per app, not per namespace
- Read-only Kubernetes RBAC — no write verb anywhere
- Path traversal guards on both the secret path and the chart path

**The Secret Manager half is now verified.** #274 recorded a GCP custom role
claimed to exclude `versions.access`, said to live in
`terraform-new/stacks/06-workload-identity` and present in neither repository.
Checked against live GCP on 2026-08-31:

```
secret-service@tesseracthub-480811.iam.gserviceaccount.com
  -> projects/tesseracthub-480811/roles/secretManagerWriteBlind   (its ONLY role)

Secret Manager Write-Blind (GA)
"Manage secrets and versions without permission to read a payload"

secrets.create  secrets.delete  secrets.get  secrets.list  secrets.update
versions.add  versions.destroy  versions.disable  versions.enable
versions.get  versions.list
```

`secretmanager.versions.access` — the one permission returning a payload — is
absent. `versions.get` returns version metadata and `secrets.get` returns the
secret's metadata; neither returns bytes.

Four angles, because a project-level role list alone would not have been
conclusive: the role excludes the permission; it is the SA's only project-level
role; a project-wide asset search for the SA returned **exactly one** IAM policy,
this binding, so no per-secret grant widens it; and the project has **no parent
org or folder**, so there is nothing to inherit and project level is the whole
policy surface.

Not fully empirical: reading a secret while impersonating the SA was refused for
want of `iam.serviceAccountTokenCreator` — itself reassuring, since it means the
SA is not broadly impersonable. Policy Troubleshooter is disabled on the project
and was deliberately not enabled. The residual assumption is GCP's own
`versions.access` => payload contract, not an inference about this estate.

**The role is real but unmanaged.** It exists only in live GCP — not in
`tesserix-infra`, not in `tesserix-k8s`, not where #274 says it lives. So
nothing would notice if `versions.access` were added to it, and the write-blind
property would be lost silently. Same shape as the Zitadel lockout policy
(#445): correct today, declared nowhere. Tracked separately.

## 7. Out of scope

- #273 criterion 3 (two-phase granting). The current apply-then-propose ordering
  has a stated reason — *"a rebuilt OpenBao comes back with no memory of the
  grant"* — so changing it is its own decision, not part of the move.
- #273 criterion 5 (denylist in OpenBao, whitelist in Git). Documented as a split
  with its reconciliation, or unified, separately.
- The scoped machine identity. Required for the Git record to be honest, tracked
  as its own issue because it is true whether or not this design ships.
