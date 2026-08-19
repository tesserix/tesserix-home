# Runbook — Zitadel identity for the console

Who can sign in to `console.tesserix.app`, how to add and remove them, and the
ways this has gone wrong.

Written 2026-08-19, after an evening in which every operator was one expired
session away from being locked out of both the console and Zitadel itself.
[ADR-003](./ADR-003-CONSOLE-TOPOLOGY.md) D4 requires a break-glass path to be
*"written down and exercised once, before the second login is removed"*. The
second login was removed first. This is the write-down; the exercise is #288.

## The facts, verified rather than assumed

| | |
|---|---|
| Issuer | `https://auth.tesserix.app` |
| Operators' organization | `386377229942128837` (Tesserix) |
| Instance default organization | `386261254651576970` |
| `platform-console` project | `386377618200461939` |
| Console OIDC application | `386382971877196703` |

**Operators and the project are in the SAME organization.** A code comment in
`apps/console/lib/auth/oidc.ts` claimed for months that they were in different
ones. It was stale, and it cost an evening: it sent the diagnosis toward project
grants, which cannot be the answer because there are none — and there are none
precisely because everything is in one org.

If a comment and the Zitadel console disagree, the console is right. Check
**Project → Role Assignments**: it says *"all the role assignments on your
organization"*.

## Adding an operator

1. **Create the user in the Tesserix org** (`386377229942128837`), not the
   default org, and not the ZITADEL org.
2. **Set a password.** Admin path: user → Login Methods → Password → edit. That
   dialog asks only for a new password. The form asking for a *current*
   password is self-service and fails with `User has not set a password`.
3. **Assign roles**: `platform-console` project → Role Assignments → New.
   Assign **all** the capabilities the operator needs — at minimum `read`,
   plus the surfaces they work in (`crm`, `support`, `platform`).
4. Have them sign in once and confirm the surfaces render.

### Roles are not optional, and their absence does not look like a permissions error

The project has **"Only authorized users can authenticate"** ON:

> *"Deny authentication if the user has no roles assigned to this project."*

So an operator with no role assignment fails at **login**, with
`Username or Password is invalid` — indistinguishable from a wrong password.
Check the role assignment before debugging the credential.

## Removing an operator

Remove their **role assignment** on `platform-console`. That is sufficient: with
the setting above, they can no longer authenticate.

**Do not delete the user to revoke access.** Deleting a Zitadel user discards
its role grants silently, and if that user is the one carrying the grants you
depended on, they are gone with it — see the traps below.

### Revocation is not immediate

Roles are copied into the `tx_session` cookie **at login**, and sessions last
7 days. Removing a grant does not reach a live session. Until #285 lands, the
revocation procedure is: remove the grant **and** confirm the person's session
has ended.

## The traps, each of which cost time on 2026-08-19

### Removing an IdP link before setting a password leaves no credential

A user federated to an external IdP has no password. Unlinking the IdP first
leaves them with no way to authenticate at all. The only rescue is an admin
session that is already open.

**Order: set a password, verify it works, then unlink.**

### Deleting a user silently discards its role grants

Zitadel treats a user and its grants as one object. During troubleshooting a
duplicate user was created, and the *original* — which held every role
assignment — was deleted instead. Nothing warned that it was the one that
mattered.

**Before deleting a user, check Role Assignments for what it carries.** The
Creation Date column distinguishes an original from a same-day duplicate.

### Two users with the same email make login non-deterministic

A user existed in both the default org and the Tesserix org with the same
address. Which one a login resolved to depended on org scope, so the same
password worked in the Zitadel portal and failed in the console.

**One person, one user.** If you find a duplicate, keep the one carrying the
role assignments.

### An unscoped login resolves in the instance default org

Without an org scope, Zitadel resolves a login name in the **instance default
organization**. The console previously sent no scope, which worked only while a
duplicate operator existed in that default org. When the duplicates went, every
login failed.

Fixed by `ZITADEL_ORG_ID` (tesserix-home#287, tesserix-k8s#448), which pins the
console to `386377229942128837` and makes it independent of an instance-wide
setting anything else could change.

**This is distinct from `ZITADEL_INTERNAL_ORG_ID`**, which stays unset.
`ZITADEL_ORG_ID` says where to authenticate; `ZITADEL_INTERNAL_ORG_ID` is a
check applied to the returned token. Conflating them broke the first cutover.

## Break-glass: locked out of the console

**Do not remove the last working credential to test this.** The whole reason
this document exists is that it was, accidentally.

1. **If any admin session is still open anywhere**, use it immediately to set a
   password on an operator's user. Do not close that tab.
2. **If no session is open**, the recovery path runs through the Zitadel
   instance's own admin, whose credentials live in OpenBao under
   `kv/data/hms/api/*`. ADR-003 D4 names the circularity: the secrets surface
   that administers those credentials is itself gated on Zitadel. The
   non-console path is `kubectl` plus the OpenBao CLI, by an operator with
   cluster access.
3. **This path has never been exercised.** #288 tracks doing so.

## What changed on 2026-08-19

- Google removed as an identity provider, and the operators' Google links
  removed — part of ADR-003 D4, and one of the four auth paths #165 is about.
  Google's own OAuth client was rejecting Zitadel's callback with
  `redirect_uri_mismatch` regardless.
- Auth Token Type switched Bearer → JWT, and the Refresh Token grant enabled,
  for the platform API (#278).
- Four capability roles added — `crm`, `support`, `billing`, `platform` (#261).
- Duplicate operator users removed; the instance default organization changed
  to Tesserix as an unblock, then made irrelevant by `ZITADEL_ORG_ID`.
