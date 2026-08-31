---
quick_id: 260831-f7m
slug: audit-actor-and-support-signature
date: 2026-08-31
status: complete
branch: fix/audit-actor-and-support-signature
base: 9c4c77e
---

# console_audit_log holds subjects, and a ticket reply is signed "Tesserix Support"

Both corrections landed. Nothing in the plan's "Out of scope" list was touched:
`Principal.Name`, `Principal.Email` and the userinfo resolver are all still
present, no migration or backfill was written, no existing row was modified,
and nothing under `apps/console/` or in `crm_activities` was changed.

## Task 1 — `console_audit_log.actor` is a subject, always

`auditActor()` returns `a.Subject` unconditionally. The comment that justified
the old behaviour was rewritten rather than trimmed: it now names both tables,
says which one had no rows when the claim was written, says which one actually
carries an email and who writes it, and cites `apps/console/lib/crm-write.ts`
for the contract. It also records that the old code matched the contract only
by accident, because the email was empty for every operator until #450.

`Actor.Email` is gone from the crm module, along with the `Email:` in the
`service.Actor{...}` literal in the crm handler. The struct's own doc comment
said it was "narrower than the tickets module's Actor, which also carries a
display name" — true when written, false after Task 2, so it was rewritten too.

## Task 2 — a staff reply is signed "Tesserix Support", and carries no email

`displayName()` returns the fixed label unconditionally, with a docstring that
says the label is the intended identity of a platform reply rather than a
fallback, names the failure mode (staff PII disclosed to a merchant), and notes
that `author_name` is NOT NULL and rendered directly. The receiver is unnamed,
which is the compiler-visible form of "this does not depend on the actor".

`AuthorEmail` is the empty string at the `InsertReply` call site; `nullIfEmpty`
in the repository turns that into a NULL column. `AuthorUserID: actor.Subject`
is unchanged, and the comment above the call says explicitly that internal
attribution was NOT lost and that the email must not be "restored" on that
belief.

`Actor.Name` and `Actor.Email` are gone from the tickets module, and `actorOf`
is a one-line reduction to the subject with a rewritten comment.

## Files changed

| File | Change |
| --- | --- |
| `platform-api/internal/modules/crm/internal/service/service.go` | `auditActor()` returns the subject; `Actor.Email` removed; both comments rewritten |
| `platform-api/internal/modules/crm/internal/handler/handler.go` | `service.Actor{Subject: principal.Subject}` |
| `platform-api/internal/modules/tickets/internal/service/service.go` | `displayName()` fixed label; `AuthorEmail: ""`; `Actor.Name`/`Actor.Email` removed; comments rewritten |
| `platform-api/internal/modules/tickets/internal/handler/handler.go` | `actorOf` passes only the subject; comment rewritten |
| `platform-api/internal/platform/auth/verify.go` | comment only — see Deviations |
| `platform-api/internal/modules/crm/internal/service/service_test.go` | new — `TestAnAuditActorIsTheSubject` |
| `platform-api/internal/modules/tickets/internal/service/service_test.go` | rewritten — #450's `TestDisplayName` replaced by two tests |
| `platform-api/internal/modules/crm/internal/handler/next_action_test.go` | audit actor assertion moved from the email to the subject |
| `platform-api/internal/modules/tickets/internal/handler/testdata/detail.json` | golden, regenerated |
| `platform-api/internal/modules/tickets/internal/handler/testdata/reply.json` | golden, regenerated |

## Task 3 — tests

- `TestAnAuditActorIsTheSubject` (crm service) — pins the subject.
- `TestAReplyIsSignedByThePlatformRatherThanByTheOperator` (tickets service) —
  replaces #450's `TestDisplayName`, which asserted the behaviour being
  reversed. Its fallback cases went with it: there is nothing left to fall back
  from.
- `TestAStoredReplyCarriesTheLabelNoEmailAndTheSubject` (tickets service) — a
  database test that goes through `Service.Reply` and reads the three columns
  back. `author_email` is scanned into a `*string` so NULL is distinguishable
  from a blank string. `author_user_id` is pinned because it is now the only
  attribution on the row.
- `TestANextActionLandsWithItsAuditRow` (crm handler) — asserted
  `actor == "operator@tesserix.test"`. Now asserts the subject.

Both new tickets tests were mutation-checked before being kept. Reverting
`displayName` to return a name and `AuthorEmail` to a staff address produced:

```
--- FAIL: TestAReplyIsSignedByThePlatformRatherThanByTheOperator (0.00s)
    service_test.go:25: displayName() = "Mahesh Sangawar", want "Tesserix Support"
--- FAIL: TestAStoredReplyCarriesTheLabelNoEmailAndTheSubject (0.30s)
    service_test.go:66: author_name = "Mahesh Sangawar", want "Tesserix Support" — a merchant is being shown a staff member
    service_test.go:69: author_email = "staff@tesserix.app", want NULL — a staff member's address reached a merchant
```

## Verification

`gofmt -l . && go build ./... && go vet ./... && go test -count=1 ./...` from
`platform-api/`. The first three produced no output; the suite passed. Full log
(`[no test files]` lines elided, module path abbreviated):

```
ok  	.../internal/architecture	0.374s
ok  	.../internal/modules/aiusage/internal/handler	5.782s
ok  	.../internal/modules/aiusage/internal/ingest	5.162s
ok  	.../internal/modules/audit	1.278s
ok  	.../internal/modules/audit/internal/handler	1.526s
ok  	.../internal/modules/audit/internal/service	1.791s
ok  	.../internal/modules/billing/internal/handler	1.983s
ok  	.../internal/modules/billing/internal/service	1.642s
ok  	.../internal/modules/crm/internal/domain	1.718s
ok  	.../internal/modules/crm/internal/handler	13.062s
ok  	.../internal/modules/crm/internal/repository	7.650s
ok  	.../internal/modules/crm/internal/service	2.592s
ok  	.../internal/modules/entities/internal/handler	2.837s
ok  	.../internal/modules/entities/internal/service	3.457s
ok  	.../internal/modules/health/internal/cluster	3.153s
ok  	.../internal/modules/health/internal/domain	3.760s
ok  	.../internal/modules/health/internal/handler	4.033s
ok  	.../internal/modules/health/internal/service	4.114s
ok  	.../internal/modules/inbox/internal/handler	4.111s
ok  	.../internal/modules/inbox/internal/service	4.023s
ok  	.../internal/modules/koraaimetrics/internal/handler	4.150s
ok  	.../internal/modules/koraaimetrics/internal/service	3.483s
ok  	.../internal/modules/kpis/internal/handler	3.407s
ok  	.../internal/modules/kpis/internal/service	3.003s
ok  	.../internal/modules/onboardingfunnel/internal/handler	3.114s
ok  	.../internal/modules/onboardingfunnel/internal/service	3.391s
ok  	.../internal/modules/outbox	3.361s
ok  	.../internal/modules/outbox/internal/handler	3.461s
ok  	.../internal/modules/outbox/internal/service	3.666s
ok  	.../internal/modules/sources/internal/handler	3.847s
ok  	.../internal/modules/sources/internal/service	4.109s
ok  	.../internal/modules/tenants/internal/handler	3.747s
ok  	.../internal/modules/tenants/internal/service	3.790s
ok  	.../internal/modules/tickets/internal/domain	3.870s
ok  	.../internal/modules/tickets/internal/handler	18.301s
ok  	.../internal/modules/tickets/internal/repository	12.161s
ok  	.../internal/modules/tickets/internal/service	4.193s
ok  	.../internal/modules/tools/internal/domain	3.957s
ok  	.../internal/modules/tools/internal/handler	18.017s
ok  	.../internal/modules/tools/internal/repository	7.215s
ok  	.../internal/platform/audit	7.266s
ok  	.../internal/platform/auth	4.195s
ok  	.../internal/platform/config	4.408s
ok  	.../internal/platform/database	4.290s
ok  	.../internal/platform/federation	4.239s
ok  	.../internal/platform/httpx	4.383s
ok  	.../internal/platform/idempotency	7.564s
ok  	.../internal/platform/paging	3.288s
ok  	.../internal/platform/reqid	3.441s
ok  	.../internal/platform/testdb	3.719s
ok  	.../internal/platform/write	5.107s
```

That run had `TESSERIX_TEST_DB_*` pointed at a throwaway `postgres:15-alpine`
container, matching `.github/workflows/platform-api.yml`. The container was
removed afterwards. **This mattered.** The bare `go test ./...` the plan asks
for was green on the FIRST attempt, because every database test skips without
`TESSERIX_TEST_DB_HOST` — and it was hiding two real failures that CI would
have caught:

```
--- FAIL: TestANextActionLandsWithItsAuditRow (0.21s)
    next_action_test.go:250: actor = "zitadel-operator-1", want the operator's email
--- FAIL: TestGoldenResponses (0.29s)
    golden_test.go:127: testdata/detail.json changed.
    golden_test.go:128: testdata/reply.json changed.
```

Both were this plan's own change showing up where the plan did not anticipate
it, and both were fixed rather than suppressed. The bare command was re-run
after the fixes and is also green.

## Deviations and judgement calls

1. **Two failures the plan did not list, found only with a database.** The
   `console_audit_log.actor` assertion in the crm handler's
   `TestANextActionLandsWithItsAuditRow` encoded the old email behaviour, and
   the tickets handler's golden files pinned `author_name` and `author_email`
   to the operator. The handler test was corrected to assert the subject. The
   golden files were regenerated with `-update-golden`; the only diff is
   `"author_name": "Tesserix Support"` and `"author_email": ""` in
   `detail.json` and `reply.json`. `author_email` is `""` rather than absent in
   the wire response because the repository's SELECT already
   `COALESCE(author_email, '')`s it — the wire shape the console parses is
   unchanged, only the value.

2. **One comment edited in `internal/platform/auth/verify.go`.** The plan says
   to leave that package alone "apart from what compiles", and no code there
   was changed. But the doc comment on `Principal.Name` asserted that the field
   "reaches a merchant" via tickets' `displayName()` — which this change makes
   false, and which is precisely the claim the open question about that field
   turns on. Leaving a comment that argues for keeping a field on grounds that
   no longer hold would have prejudiced the decision being put to you. It now
   states that the field has no reader, and that the resolver's fate is
   undecided. Revert this one hunk if you would rather the file were untouched.

3. **Two of the plan's test specifications became unsatisfiable as written,**
   because they conflict with the field removals in the same plan.
   "`auditActor()` returns the subject even when an email is present" and
   "`author_name` is `"Tesserix Support"` even when the actor has a name and an
   email" both require setting fields that Tasks 1 and 2 delete. The tests
   assert what is still expressible — the subject is returned, the label is
   stored — and each docstring records that the stronger half of the guarantee
   is now in the type rather than in the assertion: there is no field left to
   return.

4. **The stored-reply test needs a database and skips on a laptop.** The three
   properties that matter — the label, the absent email, the retained subject —
   are three separate columns, and only one is visible from `displayName()`. A
   pure unit test would have pinned a third of the change. It runs in CI, and it
   was run locally against a real Postgres before being committed.
