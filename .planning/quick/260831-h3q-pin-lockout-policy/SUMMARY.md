---
quick_id: 260831-h3q
slug: pin-lockout-policy
date: 2026-08-31
status: complete
issue: tesserix-home#445
repo: tesserix-k8s
branch: feat/pin-zitadel-lockout-policy
commit: 60e688409bc3ff1a858ec56ac63cf79c4c9ba7f0
---

# Pinned Zitadel's lockout policy

`zitadel-bootstrap` now declares and reconciles `lockoutPolicy` alongside
`labelPolicy` and `loginPolicy`. `maxPasswordAttempts` and `maxOtpAttempts` are
both `"10"` — Zitadel's own current values, restated in git rather than
inherited, so that a change to them is a diff rather than a silence.

No console code. #445's premise, that the console must implement TOTP rate
limiting, is disproved by the experiment recorded in the PLAN: Zitadel locks the
user on the 11th wrong code submitted through `PATCH /v2/sessions/{id}`, which is
the exact call `submitTotp` makes. The bound already exists; it was just
unmanaged. The numbers were not changed, and whether 10 is the right number —
along with the lockout-as-denial-of-service question — stays open on the issue.

## Files changed

### tesserix-k8s — `feat/pin-zitadel-lockout-policy`, commit `60e68840`

Modified:

- `charts/apps/zitadel-bootstrap/values.yaml` — new `desired.lockoutPolicy`
  block after `loginPolicy`, with the WHY comment: it was `isDefault: true`, it
  is the only bound on TOTP guessing, it was verified to apply to the session
  API, `0` means unlimited, and the values are quoted deliberately.
- `charts/apps/zitadel-bootstrap/files/bootstrap.py` — `reconcile_lockout_policy`
  modelled on `reconcile_login_policy`: GET `/admin/v1/policies/lockout`,
  `drift_between`, and on drift `strip_readonly(live)` overlaid with the declared
  fields and PUT back, `SystemExit` on non-200. Called from `main` immediately
  after `reconcile_login_policy`. The module docstring's "branding, login policy
  and admins" became "branding, policies and admins".
- `charts/apps/zitadel-bootstrap/files/bootstrap_test.py` — `LockoutPolicyTest`
  (6 cases) plus a `yaml_lockout_policy()` helper, and `lockoutPolicy` wired
  into `MainTest`'s config and canned responses so the in-sync-performs-no-writes
  property covers it too.

### tesserix-home — this directory only

- `.planning/quick/260831-h3q-pin-lockout-policy/PLAN.md`
- `.planning/quick/260831-h3q-pin-lockout-policy/SUMMARY.md`

## The strings

The declared values are `"10"`, not `10`, and that is load-bearing. The API
returns them as strings; `drift_between` compares by equality; `10 != "10"`. An
integer declaration reports drift on every single run and PUTs forever against a
policy that is already correct — the non-convergence trap that function's own
docstring describes.

`test_integer_ten_is_not_equal_to_string_ten` pins it from both ends: it asserts
`drift_between({"maxOtpAttempts": 10}, {"maxOtpAttempts": "10"})` is drift, and
it reads `values.yaml` back and asserts both values are still `str`. That second
half is why the helper hand-parses the block instead of using PyYAML — a real
loader would return `10` for a bare scalar and the regression would pass
unnoticed, quite apart from this test file being stdlib-only by design. Verified
to bite: unquoting `maxOtpAttempts` in `values.yaml` fails the test with
`{'maxOtpAttempts': 10} != {'maxOtpAttempts': '10'}`, and it was re-quoted.

## Tests

`python3 bootstrap_test.py` from `charts/apps/zitadel-bootstrap/files/`, exit 0:

```
----------------------------------------------------------------------
Ran 74 tests in 0.006s

OK
```

The new cases, verbatim from that run:

```
test_integer_ten_is_not_equal_to_string_ten (__main__.LockoutPolicyTest)
Regression: declaring these as ints never converges, so the quotes are load-bearing. ... ok
test_no_write_when_policy_matches (__main__.LockoutPolicyTest) ... lockout policy: in sync
ok
test_put_preserves_live_fields_the_chart_does_not_declare (__main__.LockoutPolicyTest)
PUT replaces the policy, so an undeclared field must be sent back as-is. ... lockout policy: updating ['maxOtpAttempts']
ok
test_raises_on_api_error (__main__.LockoutPolicyTest) ... lockout policy: updating ['maxOtpAttempts', 'maxPasswordAttempts']
ok
test_writes_the_declared_values_when_the_bound_drifts (__main__.LockoutPolicyTest) ... lockout policy: updating ['maxOtpAttempts']
ok
test_writes_when_the_bound_drifts_to_unlimited (__main__.LockoutPolicyTest)
0 is not a smaller number, it is no limit at all — the failure this pins. ... lockout policy: updating ['maxOtpAttempts', 'maxPasswordAttempts']
ok
```

The suite was 68 tests before; all 68 still pass unchanged.

`helm template` also renders the ConfigMap with the quoting intact —
`lockoutPolicy\":{\"maxOtpAttempts\":\"10\",\"maxPasswordAttempts\":\"10\"}` —
so `toJson` is not the place the strings could be lost.

## Deviations and judgement calls

**Two extra tests beyond the plan's minimum.** The plan asked for four
properties; there are six cases. `test_writes_when_the_bound_drifts_to_unlimited`
covers live `"0"` specifically, because `0` is the failure the whole change
exists to catch and "drift" and "unlimited" are not the same assertion.
`test_raises_on_api_error` mirrors the login reconciler's equivalent.

**`MainTest` was extended, not left alone.** `reconcile_lockout_policy` reads
`desired["lockoutPolicy"]` as a required key, exactly as `reconcile_login_policy`
reads `loginPolicy`, rather than `.get()` with a skip. A `.get()` would let a
future values.yaml drop the block and have the job report success while nothing
bounds TOTP guessing — the same silence this change removes. That makes the key
mandatory, so `MainTest._config` and `_responses` gained it.

**One quoting risk, accepted.** `values.yaml`'s existing comment on the lifetimes
explains that they are deliberately unquoted because a key ending in `password`
assigned a quoted string trips GitGuardian's generic-password heuristic.
`maxPasswordAttempts: "10"` contains `Password` and is quoted. It does not *end*
in `password`, and no GitGuardian or gitleaks step exists in this repo's
workflows, so this was left as the plan specifies — the quotes are required for
correctness and the lifetimes' workaround (dropping them) is not available here.
If a scan does flag it, the fix is an allowlist entry, not unquoting.

**Nothing was run against the live instance.** No Zitadel users created, no probe
re-run, no cluster queried. The evidence in PLAN.md was taken as established.
The reconciler has not yet run in production; it will on the next scheduled job
after merge, and the expected first-run log line is `lockout policy: in sync`,
since the declared values match what the instance already reports.
