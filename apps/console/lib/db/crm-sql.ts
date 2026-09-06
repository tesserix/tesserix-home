/**
 * The SQL fragments that more than one CRM repository module substitutes into
 * its own queries — and, deliberately, the ONLY definition of each.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: nothing outside this file may re-spell
 * one of these fragments inline, and no "tidy" pass may push a fragment back
 * down into the single module that looks like its owner. Every one of them is
 * read by two or more surfaces that have to agree, and each helper's own doc
 * comment below records the defect that agreement was bought with.
 *
 * `primaryContactOrder` and `notErased` are the sharpest case. The two
 * follower clauses, `hasEmail`, and the four display subqueries in
 * `listOrganisations` form ONE set that must all resolve the SAME contact;
 * `organisationDetail` orders its contact list the same way so that following
 * a list row to its detail page cannot show a different "primary" person than
 * the list did. A second copy is how those drift apart, and they have drifted
 * before — twice. #563 added a mutation-proven test for it: dropping the
 * display subquery's `ORDER BY` fails with `expected 15000 to be 200`.
 *
 * This module imports from none of the other `crm-*-repo` modules, and must
 * not start to: it sits underneath all of them.
 */
import { FOLLOWER_BANDS, UNKNOWN_FOLLOWERS, type FollowerFilter } from "./crm-filters";
import { isOutboundActivityKind, NEXT_ACTION_DAYS, type CrmActivityKind } from "../crm";

/**
 * The one ordering that decides which contact is "the primary": the flagged
 * contact, then the oldest, then by `id`.
 *
 * One helper rather than the ordering spelled out at each site because seven
 * queries use this ordering — four display subqueries and two filter
 * subqueries in `listOrganisations`, `wonWithoutConversion`'s primary-email
 * lookup, and `organisationDetail`'s full contact list (which orders the
 * whole list this way rather than picking one row) — and they must agree.
 * Two of them previously ordered by `name` instead, so following a list row
 * to its detail page could show a different "primary" contact than the list
 * did.
 *
 * `id` last is load-bearing: `crm_contacts.created_at` is not unique (an
 * import writes a batch of contacts in one transaction, sharing it exactly),
 * so without a total order each subquery breaks a tie independently — the
 * `followers`/`hasEmail` filter matching on one contact while the row on
 * screen shows another. Same reason the organisation keyset carries `id`.
 *
 * @param alias the table alias in the calling query, or "" when unaliased.
 */
export function primaryContactOrder(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return `${prefix}is_primary DESC, ${prefix}created_at ASC, ${prefix}id ASC`;
}

/**
 * The predicate that keeps an ERASED contact out of primary-contact
 * selection (#301).
 *
 * Erasure (`crm-erasure.ts`) redacts a contact in place — it does not delete
 * the row, and deliberately so: the organisation keeps its history and its
 * activity trail. But `is_primary` survives that redaction, so without this
 * predicate the erased row stays the contact every queue and browse filter
 * resolves to. An organisation whose primary contact exercised erasure was
 * then filtered on a person who asked to be forgotten, and — where a LIVE
 * second contact existed — on the wrong person entirely: the live contact's
 * follower count and email were invisible to the filters while the erased
 * row held the primary slot.
 *
 * Applied wherever ONE contact is picked to stand for the organisation: the
 * two follower clauses, `hasEmail`, and `listOrganisations`' primary-contact
 * lateral, which resolves the four display columns together. (The one place
 * that picks a single contact without it is `wonWithoutConversion`'s lateral,
 * for the reason its own comment gives — it selects on `email IS NOT NULL`,
 * which erasure already excludes.) It is applied to nothing that reads the
 * organisation's contacts as a record: `organisationDetail` still lists the
 * erased contact, because "who is primary for queue purposes" and "what does
 * this organisation's file contain" are different questions and only the
 * first is about erasure. `contact_count` likewise still counts it.
 *
 * An organisation whose ONLY contact is erased therefore has no primary
 * contact at all, and falls into the Unknown follower band — which already
 * exists to hold exactly that shape of row (see
 * `primaryContactFollowerUnknownClause`).
 *
 * `platform-api`'s `primaryContactExists` carries the same predicate; the two
 * implementations are both live against the same schema and must not disagree
 * on a compliance-adjacent surface.
 *
 * @param alias the table alias in the calling query, or "" when unaliased.
 */
export function notErased(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return `${prefix}erased_at IS NULL`;
}

/**
 * The soft-delete predicate for opportunities (#251), in the shape
 * `notErased` above uses for contacts and for the same reason: written out by
 * hand it is a conjunct nobody can find, and the whole risk of a void is a
 * query that was missed.
 *
 * A voided deal is one an operator has said should never have been in the
 * funnel. It keeps every row it had — nothing is deleted, and `restoreOpportunity`
 * puts it back — but it leaves every surface that answers "what is in play"
 * (both work queues, the Closed list, the browse list's `open_opportunities`),
 * every clock that would reschedule it (`CLOCK_ELIGIBLE_SQL`), the handoff
 * queue that would ask someone to attribute a tenant to it
 * (`wonWithoutConversion`), and the write that would do the attributing
 * (both of `linkConversion`'s deal lookups).
 *
 * Not every query takes it, and each one that declines says so where it
 * declines: `organisationDetail`, `listOrganisations`' `products` array, and
 * `organisationFilterClauses`' product EXISTS all keep voided deals on
 * purpose. Use this helper only where the answer is "excluded"; adding it
 * somewhere new is a decision, not a tidy-up.
 *
 * @param alias the table alias in the calling query, or "" when unaliased.
 */
export function notVoided(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return `${prefix}voided_at IS NULL`;
}

/**
 * `EXISTS` clause matching organisation `${orgAlias}.id`'s PRIMARY contact
 * into `band` — selected with `primaryContactOrder()`, the same ordering the
 * row itself is displayed with, so a filter can never resolve a different
 * contact than the one on screen (see that function's doc comment for why
 * that has been a defect twice already). Shared by the queue's `filterClause`
 * and the browse surface's `organisationFilterClauses` so the two can never
 * drift apart on what "the primary contact's follower band" means.
 *
 * A NULL `followers_count` is excluded explicitly (`IS NOT NULL`), not left
 * to fail the upper bound implicitly: `NULL <= 999` is NULL, not true, in
 * SQL, so the exclusion holds either way — but leaving it implicit would
 * make that reliance invisible to the next reader.
 */
export function primaryContactFollowerClause(
  orgAlias: string,
  band: FollowerFilter,
  params: unknown[],
): string {
  if (band === UNKNOWN_FOLLOWERS) {
    return primaryContactFollowerUnknownClause(orgAlias);
  }
  const bounds = FOLLOWER_BANDS[band];
  params.push(bounds.min);
  const minParam = `$${params.length}`;
  let upperBound = "";
  if (bounds.max !== null) {
    params.push(bounds.max);
    upperBound = ` AND c.followers_count <= $${params.length}`;
  }
  return `EXISTS (
        SELECT 1 FROM crm_contacts c
         WHERE c.organisation_id = ${orgAlias}.id
           AND c.id = (
             SELECT c2.id FROM crm_contacts c2
              WHERE c2.organisation_id = ${orgAlias}.id
                AND ${notErased("c2")}
              ORDER BY ${primaryContactOrder("c2")}
              LIMIT 1
           )
           AND c.followers_count IS NOT NULL
           AND c.followers_count >= ${minParam}${upperBound}
      )`;
}

/**
 * The complement of every band: organisation `${orgAlias}` has no primary
 * contact carrying a follower count.
 *
 * `NOT EXISTS`, scoped to the primary contact the same way the bands are, so
 * an organisation whose SECONDARY contact has 50k followers is still
 * "Unknown" — the bands describe the contact the row displays, and an
 * option that disagreed with them about which contact it means would put the
 * same organisation in two answers, or in neither.
 *
 * An organisation with no contacts at all satisfies this clause vacuously,
 * which is deliberate: it has no follower count to show either, its cell is
 * as blank as an unmeasured contact's, and excluding it would leave it
 * reachable from no follower option at all — the very defect this option
 * exists to fix. Band ∪ band ∪ band ∪ unknown therefore covers every row.
 *
 * Takes no `params`: this is a NULL/absence test, with nothing to bind.
 */
export function primaryContactFollowerUnknownClause(orgAlias: string): string {
  return `NOT EXISTS (
        SELECT 1 FROM crm_contacts c
         WHERE c.organisation_id = ${orgAlias}.id
           AND c.id = (
             SELECT c2.id FROM crm_contacts c2
              WHERE c2.organisation_id = ${orgAlias}.id
                AND ${notErased("c2")}
              ORDER BY ${primaryContactOrder("c2")}
              LIMIT 1
           )
           AND c.followers_count IS NOT NULL
      )`;
}

/**
 * The rows a bare clock bump may touch, as one SQL fragment both branches of
 * `advanceContactClock` — and `recordTemplatedDm` — substitute in.
 *
 * IT IS ONE CONSTANT BECAUSE IT WAS ONCE TWO COPIES, AND ONE OF THEM WAS
 * EMPTY. The organisation-wide branch carried both guards from the start; the
 * by-id branch carried neither, and the two sat six lines apart in this file
 * disagreeing about which rows a clock bump is allowed to reach. That is not a
 * cosmetic difference:
 *
 *   Migration 0021's CHECK (`stage IN ('new','contacted') OR product IS NOT
 *   NULL`) is re-evaluated against the NEW row version of every UPDATE,
 *   including one that only moves a timestamp. So a per-deal log against a
 *   grandfathered qualified/won/lost opportunity with a null product aborted
 *   the whole transaction — taking the `crm_activities` insert down with it.
 *   The operator was told their note could not be saved, and the reason was
 *   that an unrelated deal is missing a product.
 *
 * Losing the record of the contact is the expensive failure; a grandfathered
 * row that keeps drifting until someone supplies the product `setNextAction`
 * already asks for is the visible, fixable one. So the predicate skips exactly
 * the rows the CHECK would reject.
 *
 * Terminal deals are excluded for a different reason, unrelated to the CHECK:
 * a won or lost deal is not being worked, so a clock that exists to say
 * "nobody has touched this lately" has nothing to say about it. The by-id
 * branch now agrees with that too — naming a won deal explicitly does not make
 * it live again.
 *
 * A VOIDED DEAL IS EXCLUDED, third and for a third reason (#251). This is the
 * clock predicate that matters most for a void, because of the
 * by-ORGANISATION branch: an activity that names no deal — every DM the
 * composer sends, every organisation-level note — bumps the clocks of EVERY
 * eligible deal on that organisation. Without this conjunct, logging a call to
 * a business would silently reschedule a deal that had been voided, giving it
 * a fresh `next_action_at` and putting it back on Due. Nothing an operator did
 * would look like the cause. The by-id branch needs it as well: naming a
 * voided deal explicitly does not un-void it, exactly as naming a won one does
 * not make it live.
 */
export const CLOCK_ELIGIBLE_SQL = `stage NOT IN ('won', 'lost')
          AND (stage IN ('new', 'contacted') OR product IS NOT NULL)
          AND ${notVoided("")}`;

/**
 * What this contact event does to `next_action_at` — the column that decides
 * which queue a lead is in (#502).
 *
 * THE COLUMN IS NOT OPTIONAL METADATA. `crm_opp_due_idx` and
 * `crm_opp_drifting_idx` are two partial indexes over the same rows split on
 * exactly this predicate: `next_action_at IS NOT NULL` is Due, `IS NULL` is
 * Drifting. So a clock bump that moved `last_contacted_at` and left this null
 * did not fail to schedule a follow-up — it actively filed the lead as
 * drifting. That is the production state the issue describes: Due empty,
 * Drifting holding all 259, every one of them reading "waiting 121d".
 *
 * OUTBOUND schedules a chase `NEXT_ACTION_DAYS` out. INBOUND is due NOW.
 *
 * The inbound half is where this departs from the issue as written, which said
 * a reply "shouldn't schedule anything, because it means act now". The
 * reasoning is right and the conclusion inverts it: null is not "act now", it
 * is the literal definition of Drifting, so leaving a reply unscheduled files
 * the hottest lead in the queue into the same bucket as the ones nobody has
 * touched since May. `now()` is what "act now" actually spells.
 *
 * A DEFAULT, NOT A RULE, and the `CASE` is where that is enforced. A date
 * already in the FUTURE is a decision the operator made about something that
 * has not happened yet, and sending a DM today does not un-make it — an
 * unconditional assignment would silently overwrite "check back in a month"
 * with "check back on Friday" every time anyone logged anything.
 *
 * A date in the PAST is not spared, and that is the other half. It described an
 * action that is now overdue, and this event is very likely that action having
 * been taken; leaving it would pin the lead permanently at the top of Due, so
 * working a lead could never take it off the list. Outbound therefore moves a
 * stale date forward, and inbound only ever pulls a date EARLIER — an overdue
 * chase that a reply arrives against stays overdue, because the reply did not
 * make it less late.
 *
 * `next_action_note` is deliberately untouched HERE. It holds the operator's
 * own words about what to do next, and a default date is not grounds to
 * rewrite them; a null note beside a real date reads as "something, soon",
 * which is honest, where a machine-written one would read as a plan nobody
 * made. `recordTemplatedDm` does write one, because it has a real fact to put
 * in it — the name of the template that was sent — and it gates that write on
 * `OUTBOUND_RESCHEDULES_SQL`, exported below, so the note and the date it
 * describes can never come apart.
 */
export const OUTBOUND_RESCHEDULES_SQL = `next_action_at IS NULL OR next_action_at <= now()`;

export function nextActionAssignment(kind: CrmActivityKind): string {
  // `NEXT_ACTION_DAYS` is a module constant integer, not caller input, so it
  // interpolates into the interval literal rather than binding as a parameter —
  // this fragment is shared by two statements whose placeholders are numbered
  // differently, and a `$n` here would have to mean something different in each.
  return isOutboundActivityKind(kind)
    ? `CASE WHEN ${OUTBOUND_RESCHEDULES_SQL}
                THEN now() + interval '${NEXT_ACTION_DAYS} days'
                ELSE next_action_at END`
    : `CASE WHEN next_action_at IS NULL OR next_action_at > now()
                THEN now()
                ELSE next_action_at END`;
}
