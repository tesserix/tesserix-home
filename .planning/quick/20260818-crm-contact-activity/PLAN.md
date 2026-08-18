# The Drifting clock can never advance (#245)

## The bug

Drifting is `next_action_at IS NULL AND stage NOT IN ('won','lost') AND
COALESCE(last_contacted_at, created_at) <= now() - 14 days`.

`last_contacted_at` has one writer — `logActivity` — and it fires only when
**both** an `opportunityId` was supplied **and** the kind is in
`CONTACT_ACTIVITY_KINDS`. The composer (`organisation-detail-view.tsx`)
hard-codes `kind: "note"` and passes no `opportunityId`, so neither holds.

Consequence: from the console `last_contacted_at` can never be written. The
drift clock always falls back to `created_at`, so **every imported
organisation enters Drifting 14 days after import and stays there forever**,
however much outreach is logged. That is exactly production: 259
organisations, all `stage=new`, all Drifting, quiet since 4 May.

Two further consequences of the same root cause:

- **Five of six kinds are unreachable.** `HUMAN_ACTIVITY_KINDS` allows
  `note`, `dm_sent`, `dm_received`, `email_sent`, `email_received`, `call`.
  Only `note` can be sent.
- **The suppression guard has never executed.** `logActivity` refuses an
  `OUTBOUND_ACTIVITY_KINDS` write when any contact on the organisation is
  suppressed — and no outbound kind is reachable, so the control that stops
  outreach to a do-not-contact person has never run in production.

## Decisions (confirmed with Mahesh)

1. **A contact event advances every open opportunity** on the organisation
   (`stage NOT IN ('won','lost')`). A call to the business is a contact with
   the business. Terminal deals are left alone.
2. **Prompt for a next action after a contact event, do not force one.**
   Offer it inline with a sensible default; an operator with nothing to
   schedule can decline.

### Decision 1 reverses a comment that is currently in the code

`crm-repo.ts` says today:

> Only when the activity is attached to a deal: `last_contacted_at` lives on
> `crm_opportunities`, and an organisation-level activity has no one deal
> whose clock it would be honest to reset.

That reasoning is why the bug exists. It is sound about *one* deal and wrong
about the conclusion: the honest answer is that the event touched **all** of
them, not none. **Replace that comment** — do not leave it sitting above code
that now does the opposite. Record why the earlier reading was reversed.

## Scope

**Data layer — `logActivity` (`crm-repo.ts`).**
- With an `opportunityId`: unchanged.
- Without one, and the kind is a contact kind: `UPDATE crm_opportunities SET
  last_contacted_at = now(), updated_at = now() WHERE organisation_id = $1
  AND stage NOT IN ('won','lost')`.
- A `note` still advances nothing, at organisation or deal level. Recording a
  thought is not contact.
- Same transaction as the activity insert, as now.

**Action layer.** `addActivity` already validates via `isHumanActivityKind`
and already accepts an optional `opportunityId` — check what actually needs
changing rather than assuming; this layer may be complete already.

**UI — the composer.** A kind selector over `HUMAN_ACTIVITY_KINDS`, defaulting
to `note`. Then, after a contact kind is logged, prompt for a next action
inline.

**The suppression path becomes live.** Once outbound kinds are reachable,
`SuppressedContactError` can be raised for the first time. It is already
allowlisted through `mapSuppressedContact`, so the message should surface —
**verify that end to end rather than assuming**, and pin it with a test. A
control going live for the first time is worth proving, not hoping.

## Verification

- A contact kind with no `opportunityId` advances **every open** opportunity
  and **no terminal** one. Assert both halves — a test that only checks the
  open ones passes even if terminal deals are wrongly bumped.
- A `note` advances nothing.
- An organisation with no opportunities does not error.
- Logging an outbound kind against a suppressed contact is refused, the
  operator sees the suppression message, and **nothing is written** — neither
  the activity nor a clock bump.
- End to end: an organisation in Drifting leaves the queue once a contact
  event is logged. That is the bug, so it needs a test that would have failed
  before.
- Mutation-test every guard, including the terminal-stage exclusion.

## Out of scope

Sending anything. This makes the CRM able to *record* outreach accurately; it
does not make it able to perform outreach — that gap is real and separate.
Do not touch `apps/web`.

## Gates

`pnpm --filter console test:unit`, `typecheck`, `lint`, `build`, `e2e`. No new
dependencies.
