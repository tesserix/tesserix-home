---
quick_id: 260831-h3q
slug: pin-lockout-policy
date: 2026-08-31
issue: tesserix-home#445
repo: tesserix-k8s
---

# Pin Zitadel's lockout policy in zitadel-bootstrap

tesserix-home#445 asks whether the console must implement TOTP rate limiting.
It must not. Zitadel already bounds it — but the bound is unmanaged.

## Evidence — established by live experiment, do NOT re-derive

Do not create Zitadel users, do not run the probe again, do not query the
cluster. Everything needed is here.

`GET /admin/v1/policies/lockout` on the live instance:

```json
{"maxPasswordAttempts": "10", "maxOtpAttempts": "10", "isDefault": true}
```

**The policy applies to session-API TOTP checks.** Established 2026-08-31 by
enrolling a disposable user with TOTP and submitting wrong codes through
`PATCH /v2/sessions/{id}` — the same call `submitTotp` makes:

```
attempts 1-10   400  Invalid code (EVENT-8isk2)
attempt 11      400  User is locked (COMMAND-SF3fg)
final state     USER_STATE_LOCKED
```

Locks at exactly 10, matching `maxOtpAttempts`. So the inversion
`login-sufficiency.ts` documents for `forceMfa` — *"Zitadel does not enforce
MFA"* for a login client — does NOT extend to lockout. They are different
mechanisms: `forceMfa` is requirement evaluation, delegated to the login
client; `maxOtpAttempts` is a failure counter inside the check command, which
Zitadel enforces regardless of caller.

## The actual defect

`isDefault: true`. The policy is Zitadel's own default, and `zitadel-bootstrap`
manages only `labelPolicy` and `loginPolicy`. Nothing declares it, so nothing
notices if it changes — and `0` means unlimited.

This estate has already lost a day to precisely that failure. `values.yaml`'s
own comment on `passwordCheckLifetime`:

> every one of these was 0s on this instance, and 0s means "expired the instant
> it is made" ... The browser goes back to the password screen with no error,
> forever. It is not a failure path: it is the policy working exactly as
> configured.

An unpinned lockout policy silently becoming `0` is the same shape, with a
worse outcome: unlimited TOTP guessing, and nothing to see.

## Tasks

### Task 1 — declare it

`charts/apps/zitadel-bootstrap/values.yaml`, a new `lockoutPolicy:` block
alongside `labelPolicy` and `loginPolicy`:

```yaml
  lockoutPolicy:
    maxPasswordAttempts: "10"
    maxOtpAttempts: "10"
```

**The values MUST be strings.** The API returns them as strings, and
`drift_between` compares declared against live: declare `10` and it differs
from `"10"` on every run, so the job reports drift and PUTs forever without
converging — the exact trap that function's docstring describes. Say this in a
comment; it is not obvious and the next person will reach for an integer.

Comment the block with WHY it is declared at all: it was `isDefault: true`,
it is the only thing bounding TOTP guessing, it was verified to apply to the
session API (cite the experiment above and #445), and `0` means unlimited.

### Task 2 — reconcile it

`charts/apps/zitadel-bootstrap/files/bootstrap.py`. Add
`reconcile_lockout_policy(desired)` modelled exactly on
`reconcile_login_policy` (:130) — GET `/admin/v1/policies/lockout`,
`drift_between`, and on drift `strip_readonly(live)` + `update(desired)` +
`PUT /admin/v1/policies/lockout`, raising `SystemExit` on non-200.

The same "PUT replaces rather than patches" caveat applies, so undeclared
fields must be sent back — that is what `strip_readonly` + overlay is for.
Note `strip_readonly` already drops `isDefault`, which this policy carries.

Call it in `main` immediately after `reconcile_login_policy` (:637).

### Task 3 — tests

`charts/apps/zitadel-bootstrap/files/bootstrap_test.py` already covers the
label and login reconcilers; mirror that style. Cover at minimum:

- in-sync (live `"10"`/`"10"` matches declared) → **no PUT issued**
- drift (live `"3"`) → PUT issued, body carries the declared values
- **a regression test that integer `10` and string `"10"` are not treated as
  equal** — i.e. that declaring an int would be caught. This is the trap in
  Task 1 and it deserves a test that fails if someone "tidies" the quotes away.
- undeclared live fields survive the PUT (the replace-not-patch property)

Run the existing suite the way the chart does — `python3 bootstrap_test.py` or
`python3 -m unittest`, from `charts/apps/zitadel-bootstrap/files/` — and report
the actual output.

### Task 4 — commit

Single line, conventional commits, no body, no signature. Suggested:
`feat(zitadel): pin the lockout policy, which is the only thing bounding TOTP guessing (tesserix-home#445)`

## Out of scope

- No console code. #445's premise that the console must own rate limiting is
  disproved by the evidence above.
- Do NOT change the values from 10. Whether 10 is the right number, and the
  lockout-as-denial-of-service question (anyone who reaches the login page can
  burn 10 codes and lock an operator out), are separate decisions for the
  issue, not this change.
