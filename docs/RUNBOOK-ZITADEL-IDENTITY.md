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
| Instance default organization | `386261254651576970` (**ZITADEL**, enforced by `zitadel-bootstrap`) |
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
setting anything else could change. Reverted in tesserix-k8s#451 and re-applied
in #489 — see below for why the revert was on a real symptom and the wrong
cause.

**The default org is `ZITADEL`, and it is held there on purpose.**
`charts/apps/zitadel-bootstrap` sets `defaultOrg: ZITADEL` and its reconciler
PUTs it back if anything changes it, so "change the default org to TESSERIX" is
not an available fix — the next bootstrap run undoes it. Its comment gives the
reason as an unscoped login resolving the default org's IdP, which was written
while Google was still an IdP. Google was removed on 2026-08-19, so that
justification is worth revisiting; the setting has not been.

**This is distinct from `ZITADEL_INTERNAL_ORG_ID`**, which stays unset.
`ZITADEL_ORG_ID` says where to authenticate; `ZITADEL_INTERNAL_ORG_ID` is a
check applied to the returned token. Conflating them broke the first cutover.

### Login V1 resolves the org differently from Login V2

This is the one that made helivanta look like proof the console needed no org
scope. It is not.

| | |
|---|---|
| `console-web` | `loginVersion: loginV1` → resolves in the **instance default org** |
| `helivanta-web` | `loginVersion: loginV2` (baseUri `https://helivanta.app`) → resolves from the **application's own project** |

Both projects are in TESSERIX. The same operator, with the same password, signs
into helivanta and not into the console — not because of OpenFGA, and not
because of `offline_access` or the project audience scope (all four scope shapes
are accepted at `/oauth/v2/authorize`), but because one of them looks for the
user where the user actually is.

So: **an app on Login V1 needs an explicit org scope. An app on Login V2 does
not.** Before concluding that one application's configuration proves anything
about another's, check which login it is on.

### A missing password looks exactly like a rejected org scope

`ZITADEL_ORG_ID` was set, tested, and reverted on 2026-08-19 because login
accepted the password and returned silently to the password screen. That symptom
was real. The cause was not the scope.

Read off the live instance afterwards:

- Exactly **one** user exists for the operator's email, in TESSERIX. Not a
  duplicate, not in the default org.
- It holds **all eleven** `platform-console` roles, so the project's
  "Only authorized users can authenticate" check passes.
- It has **no passkey, no IdP link and no MFA factor** — a password is its only
  credential — and `passwordChanged` is **05:10:42Z**.

The scope was tested *before* that timestamp. The account had no usable password
at the moment of the test. This is the first trap on this page, landing on the
diagnosis rather than on the login.

**Before concluding a configuration change broke login, confirm the account you
are testing with can authenticate at all** — ideally against a surface that
change does not touch.

## Break-glass: locked out of the console

**Do not remove the last working credential to test this.** The whole reason
this document exists is that it was, accidentally.

1. **If any admin session is still open anywhere**, use it immediately to set a
   password on an operator's user. Do not close that tab.
2. **If no session is open**, recover with the instance's own admin credential,
   read straight from Kubernetes:

   ```bash
   export KUBECONFIG=~/.kube/gke-prod
   PAT=$(kubectl -n zitadel get secret iam-admin-pat -o jsonpath='{.data.pat}' | base64 -d)
   ```

   That is a working Management API credential. **OpenBao is not involved.**

   ~~ADR-003 D4 said these credentials live in OpenBao under
   `kv/data/hms/api/*`, and that the secrets surface administering them is
   itself gated on Zitadel.~~ **That was wrong** — `kv/data/hms/api/*` is empty
   and there is no `hms/` path in OpenBao at all. Corrected 2026-08-21 (#288);
   D4 carries the correction. The credentials are in the `zitadel` namespace's
   K8s secrets and in GCP Secret Manager, neither gated on Zitadel.

3. **Reactivate and reset**, using only that credential:

   ```bash
   # find the user
   curl -s -X POST https://auth.tesserix.app/v2/users \
     -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
     -d '{"queries":[{"userNameQuery":{"userName":"THEIR_LOGIN_NAME"}}]}'

   # reactivate, if deactivated
   curl -s -X POST https://auth.tesserix.app/v2/users/USER_ID/reactivate \
     -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" -d '{}'

   # set a password
   curl -s -X POST https://auth.tesserix.app/v2/users/USER_ID/password \
     -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
     -d '{"newPassword":{"password":"...","changeRequired":true}}'
   ```

   Then check their `platform-console` role grant still exists — deleting a user
   discards its grants silently, and a user with no grant on that project cannot
   use the console even with a working password. See the traps below.

4. **Both halves have now been exercised.** The read half on 2026-08-19, while
   diagnosing the login failure above. The write half on 2026-08-21 (#288): a
   throwaway user was deliberately deactivated and recovered end to end with no
   console and no admin browser session, in **4 seconds** once the credential was
   in hand.

   **Re-verified 2026-08-31 (#288), ten days on**, because a runbook whose
   credential has since rotated away is worse than no runbook. `iam-admin-pat`
   still exists and still authenticates (HTTP 200 against `POST /v2/users`), and
   the whole write half ran again on a throwaway user — deactivate, reactivate,
   set password, delete — in **2 seconds**. Re-check this on any deliberate
   schedule; the credential is the single point the whole procedure rests on.

   **What is still untested is the human half** — whether someone unfamiliar can
   follow this under pressure, and whether the people holding cluster and GCP
   admin know that they are the recovery path. There is no separate break-glass
   identity: recovering Zitadel needs the same access that can already do
   anything.

5. **The admin PAT can delete users. The console's login-client token cannot.**

   `ZITADEL_LOGIN_CLIENT_TOKEN` (`console-secrets`, the PAT for the
   `console-login-client` machine user) will happily CREATE a user and then
   refuse to remove it — `403` on both `DELETE /v2/users/{id}` and
   `DELETE /management/v1/users/{id}`. `iam-admin-pat` returns `200`.

   Recorded because it is invisible until it strands something: on 2026-08-31
   the #445 TOTP probe created two disposable users with the login-client token
   and could not clean them up, so they had to be deactivated and then deleted
   by hand with the admin credential. Anyone scripting a create-and-clean-up
   against Zitadel should mint from `iam-admin-pat`, or plan to leave litter.

   Deactivating is not deleting. `POST /v2/users/{id}/deactivate` succeeds with
   the login-client token, which makes a stranded user *harmless* — it cannot
   authenticate — but it is still there, and it still holds whatever grants it
   had.

6. **Note on `kubectl exec`.** Several pods in this estate are distroless and
   have no shell, so `kubectl exec ... -- sh` fails. Where a procedure needs to
   authenticate as a workload, mint a token instead:
   `kubectl -n NS create token SERVICE_ACCOUNT --duration=10m`.

## What changed on 2026-08-20

- **The Refresh Token grant was actually enabled on `console-web`** (#304).
  Confirmed before and after by probing the token endpoint with a deliberately
  invalid refresh token, which separates a grant-level refusal from a
  token-level one without spending a live credential: `unauthorized_client`
  / `grant_type "refresh_token" not allowed` before, `Errors.User.RefreshToken.Invalid`
  after.

  **Zitadel was issuing refresh tokens the whole time it refused to redeem
  them.** Issuing and redeeming are separate permissions, and conflating them
  is what made this look enabled. The console stored a credential it was not
  allowed to spend, and the failure would have surfaced about an hour into a
  session — not at login — as every platform-API surface going unreachable for
  the rest of the 7-day session.

  Zitadel **rotates** refresh tokens on use: redeeming one returns a
  replacement and kills the original. That is now observed against this
  instance, and it is why `operator_api_tokens` must persist the replacement.

- `ZITADEL_POST_LOGOUT_REDIRECT_URI` set, so sign-out ends the Zitadel session
  rather than only the console cookie (#306, tesserix-k8s#516).

## What changed on 2026-08-19

- Google removed as an identity provider, and the operators' Google links
  removed — part of ADR-003 D4, and one of the four auth paths #165 is about.
  Google's own OAuth client was rejecting Zitadel's callback with
  `redirect_uri_mismatch` regardless.
- Auth Token Type switched Bearer → JWT, for the platform API (#278).
- **The Refresh Token grant was NOT enabled, though this page said it was.**
  The claim stood here for a day and was wrong: `console-web`'s grant types
  were `[AUTHORIZATION_CODE]` only until 2026-08-20. There is no second
  application it could have meant — `platform-console` contains exactly one,
  and the platform API has no Zitadel application of its own. See below.
- Four capability roles added — `crm`, `support`, `billing`, `platform` (#261).
- Duplicate operator users removed; the instance default organization changed
  to Tesserix as an unblock, then made irrelevant by `ZITADEL_ORG_ID`.
