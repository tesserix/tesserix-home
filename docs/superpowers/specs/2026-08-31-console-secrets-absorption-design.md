# Absorbing the secrets surface into the console

**Status:** design, approved in conversation 2026-08-31
**Implements:** ADR-003 D3 · tesserix-home#274 (M4-2)
**Depends on:** #273 (criteria 1 and 6 landed as secret-service#18; criterion 4 to follow)
**Supersedes premises in:** #274 ("the service holds no permission to merge" — false, see §2)
**Prototype:** https://claude.ai/code/artifact/1ce7c134-4001-4424-ba7c-e97f099ceddf — clickable, covers every flow below. Reviewed by a UX pass whose findings are folded in.

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
   Orphans sort to the top of the list and are counted above it; a chip in a row
   of chips loses a horizontal scan.

A proposal can also be **rejected**, which changes nothing but the record. That
is exactly how a secret acquires no reader without anyone having removed one, and
it is the case the derived flag exists to catch — so the reject path and the flag
have to ship together, or the flag makes a claim nothing can produce.

The derived indicator is the reason this beats a guided two-stage flow. A wizard
only knows about secrets made through the wizard; a derived state also catches a
secret orphaned by a rejected proposal, a later revocation, or a hand-made entry.
It also leaves the common cases untaxed: rotating a secret for an
already-whitelisted app, and granting an existing secret to another app, never
involve creating a secret at all.

### Removing a reader is the same route, and that is deliberate

Removing an app is a `revoke` change to the same file in the same repository, so
it takes the same gate as adding one. It is not a local toggle, and the Reviews
queue shows both directions.

A queued revoke means access stays live until someone approves it, which invites
the objection that an urgent revocation cannot wait. **The objection points at
the wrong control.** If a credential is compromised, revoking *access* is the
slow and partial answer; **rotating the value** is immediate and total — write a
new version and every holder of the old value has nothing, with no approver, no
pull request and no merge. That path already exists and needs no new mechanism.

So revocation of access is inherently a tidying operation and queuing it is
correct. What is missing is only that an approver cannot tell routine cleanup
from "please hurry" — worth an optional reason on a revoke, surfaced in the queue
and in the notification. An emergency lane is deliberately NOT added: it would be
a second, weaker path to an outcome the rotate path already achieves better.

## 6. Two stores, which are not peers

`SECRET_BACKENDS=openbao,gcpsm` is live in production, default `openbao`. The
`Store` interface (`apps/api/internal/secrets/store.go`) is uniform, so every
secret *operation* — list, describe, write, delete, destroy, restore, versions —
is identical across both. Access is not:

| | OpenBao | Google Secret Manager |
|---|---|---|
| add / update / delete a secret | `Store` | `Store`, identically |
| who may read it | whitelist in `tesserix-k8s`, via the proposal flow above | **GCP IAM, outside this tool** |

The access handlers take no backend parameter. `AddApp` / `RemoveApp` edit
`values.yaml`; there is no GSM equivalent, and inventing one is not in scope
here.

**So the stores are a filter, not a tab.** A tab asserts peerage, and these are
not peers on the axis that matters. The secrets list carries a store chip per
row and a filter — All / OpenBao / Google Secret Manager, plus a separate
"No reader" — with counts drawn from the whole set rather than the filtered
view, so a chip reports what is *not* currently on screen.

On a GSM secret, the "Who can read this" card is replaced, not emptied. It says
access is governed by GCP IAM and there is nothing for the console to propose.
Rendering an empty reader list instead would conflate two different facts —
"nothing can read this" and "this tool does not manage who reads this" — and the
first of those is the alarm the orphan flag exists to raise.

**Write-blind is enforced by IAM, not by the UI.** The console's Google
credential holds `secretManagerWriteBlind`: create, update, delete, destroy,
and metadata reads, but **not** `secretmanager.versions.access`. The `Store`
interface has no `Read` method at all, *"so no handler can leak one"*. A
compromised console cannot reveal a GSM payload, because it has no permission
to. See §9 for the caveat that this role is declared nowhere (#465).

## 7. Writing a value

The value field is hidden by default, with reveal and copy controls inside it,
and a **Generate** action beside it. Generating produces 32 random bytes.

Copy exists because the one case that needs the value is handing it to something
outside the estate — a payment provider's dashboard. The copy in the form says
what is true: **this is the only moment the value can be retrieved**, because
nothing in the console can read a stored value back.

An earlier draft offered "do not show it to me", writing a generated value that
no human ever saw. That was dropped. It reads as a stronger guarantee than it is
— the operator creating the secret can always look, and a reveal control is one
click away — and the guarantee that matters is not about the moment of creation
but about every moment after it, which `secretManagerWriteBlind` and the absent
`Store.Read` already provide.

## 8. Notifying the people a proposal is waiting on

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

## 9. Security properties that must survive, each with a test or a note

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

## 10. Out of scope

- #273 criterion 3 (two-phase granting). The current apply-then-propose ordering
  has a stated reason — *"a rebuilt OpenBao comes back with no memory of the
  grant"* — so changing it is its own decision, not part of the move.
- #273 criterion 5 (denylist in OpenBao, whitelist in Git). Documented as a split
  with its reconciliation, or unified, separately.
- The scoped machine identity (#464). Required for the Git record to be honest,
  tracked as its own issue because it is true whether or not this design ships.
- Managing GSM *access* from the console. §6 records why the stores are not peers
  on that axis. Making them peers would mean the service proposing IAM changes,
  which needs #465 settled first — you cannot propose a change to a role that is
  declared nowhere — and would give the service IAM write it does not have.
- An optional reason on a revoke (§5). Worth doing; not required for the move.

## Dependencies worth stating

- **#465** — `secretManagerWriteBlind` exists only in live GCP. §6's write-blind
  guarantee rests on it, so a surface built on that guarantee should not ship
  while the role can be widened with no diff and no failing check.
- **#285** — already delivered, and §4 and §8 both rely on it. Revoking an
  approver's capability now takes five minutes rather than up to seven days.
- **#313** — the `tesserix-k8s` bypass narrowing. §2's analysis assumes the
  current `bypass_mode: pull_request`; restoring `always` would silently re-open
  the force-push and deletion paths this design reasons about.
