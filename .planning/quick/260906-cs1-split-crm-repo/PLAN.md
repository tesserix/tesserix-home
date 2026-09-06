# Split crm-repo.ts (tesserix-home#566)

`apps/console/lib/db/crm-repo.ts` is **3612 lines** against the 800-line
ceiling — it has grown 421 lines since #566 was filed quoting 3191.

## The constraint that shapes everything

`primaryContactOrder`, `notErased` and `CLOCK_ELIGIBLE_SQL` are deliberately
single-definition. Their doc comments say why at length: the follower filter
clauses, `hasEmail` and the four display subqueries in `listOrganisations`
form ONE set that must resolve the same contact, and a second copy is how they
drift. #563 added a mutation-proven test for it (removing the display
subquery's `ORDER BY` fails with `expected 15000 to be 200`).

Note `primaryContactOrder` (:1544) and `notErased` (:1585) are currently
**not exported** — they are module-private and shared by `organisationDetail`
and `listOrganisations`, which is precisely why they cannot simply move with
one of them.

## Strategy: extract modules, keep `crm-repo.ts` as a barrel

41 files import from `@/lib/db/crm-repo`, and there are 64 exports. The barrel
re-exports every one, so **no consumer changes and no test changes** — which
is what makes this verifiable as a pure refactor: if a test had to change, the
behaviour changed.

## Modules

| module | holds |
|---|---|
| `crm-sql.ts` | `CLOCK_ELIGIBLE_SQL`, `OUTBOUND_RESCHEDULES_SQL`, `nextActionAssignment`, `primaryContactOrder`, `notErased` — the invariant-bearing set, and the ONLY definition of each |
| `crm-queue-repo.ts` | `QueueFilter`, `QueueRow`, `Page`, `QueuePage`, `ClosedRow`, `ClosedPage`, `dueOpportunities`, `driftingOpportunities`, `closedOpportunities`, `filterClause`, `queuePage` |
| `crm-write-repo.ts` | `advanceStage`, `advanceStageOnQuery`, `setNextAction`, `logActivity`, `assertNoSuppressedContact` and their input/result types |
| `crm-organisation-repo.ts` | `organisationDetail`, `OrganisationDetail`, `OrganisationRow`, `ContactRow`, `OpportunityRow`, `ActivityRow`, `ACTIVITY_LIMIT` |
| `crm-suppressions-repo.ts` | `isSuppressed`, `addSuppression`, `listSuppressions`, `removeSuppression` and their types |
| `crm-import-repo.ts` | `findMatchingOrganisationId`, `isErased`, `previewImport`, `commitImport` and their types |
| `crm-handoff-repo.ts` | `wonWithoutConversion`, `linkConversion` and their types |
| `crm-browse-repo.ts` | `listOrganisations`, `organisationFilterClauses`, `ORGANISATION_SORTS` and the sort/filter types |
| `crm-repo.ts` | barrel — re-export only |

`primaryContactOrder` and `notErased` become exported **from `crm-sql.ts`
only**, imported by `crm-organisation-repo` and `crm-browse-repo`. Neither may
re-spell them inline, and `crm-sql.ts` must carry that as a stated rule so a
later "tidy" pass does not undo it.

## Done when

- every module is under 800 lines, `crm-repo.ts` is a barrel
- **no test file is modified** — the 6109 lines across `crm-repo.test.ts`,
  `crm-repo.integration.test.ts` and `crm-repo.write.integration.test.ts` pass
  untouched, as do the 41 importers
- no SQL string is altered in any way, including whitespace
- full suite matches the 256 files / 4821 tests baseline

## Out of scope

Behaviour changes of any kind, renaming exports, "improving" a query, and
fixing anything noticed along the way — note it in the PR instead.
