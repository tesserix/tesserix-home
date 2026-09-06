/**
 * The CRM handoff surface: won deals awaiting a conversion, and the write that
 * links one.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 */
import { tesserixQuery, tesserixTx } from "./tesserix";
import { toIso } from "./crm-row";
import { notVoided, primaryContactOrder } from "./crm-sql";

/**
 * The handoff queue (Task 10): a won opportunity whose organisation has not
 * yet been linked to a conversion.
 *
 * `converted_at` lives on `crm_organisations`, not `crm_opportunities`
 * (migration 0019) — one business, one conversion, even though it can carry
 * several per-product opportunities over time — so "no conversion recorded"
 * is read off the organisation, not the individual deal.
 */

export interface HandoffRow {
  opportunityId: string;
  organisationId: string;
  organisationName: string;
  /** Null for a migrated deal, and legitimately so. 0019's
   *  `crm_opp_product_required_when_qualified` CHECK does require a product
   *  from `qualified` onward, but 0020/0021 deliberately grandfather the
   *  rows `migrate-leads-to-crm.mjs` writes: a lead that closed before this
   *  schema existed was never matched to a product, and the migration
   *  refuses to invent one (see that script's header).
   *
   *  Such a row genuinely IS won-but-not-converted, so it belongs in this
   *  queue — excluding it would hide the entire migrated backlog on day
   *  one, and `toHandoffRow` used to THROW on it, which put the whole
   *  handoff surface into its error state instead. There is also nothing
   *  lost by carrying the null: `linkConversion` takes the product from the
   *  operator's own selection, not from the opportunity, so a null-product
   *  row is still linkable by hand — and that link is where the null ends,
   *  because `linkConversion` writes the chosen product back onto the deal
   *  (#214), which is what lets the row leave this queue at all. The
   *  only thing it cannot do before that is be asked
   *  about upstream — `fetchRowSignal` has no product to address a
   *  conversion-status call to, so the row reads `unknown`, which is the
   *  honest answer rather than a fabricated `none`. */
  product: string | null;
  /** The organisation's primary contact email, if it has one — what Task 9's
   *  `fetchConversionSignal` is asked about. `null` when no contact on the
   *  organisation carries an email at all: the row still shows (an operator
   *  can still link a conversion by hand), there is just nothing to check
   *  upstream for. */
  primaryEmail: string | null;
  closedAt: string | null;
}

interface RawHandoffRow {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  primary_email: string | null;
  closed_at: unknown;
}

function toHandoffRow(row: RawHandoffRow): HandoffRow {
  return {
    opportunityId: row.id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    product: row.product,
    primaryEmail: row.primary_email,
    closedAt: toIso(row.closed_at),
  };
}

/**
 * Won opportunities not yet linked to a conversion, oldest-won-first — the
 * longest a merchant has been sitting unaccounted for is the one an operator
 * should look at first.
 *
 * Ruling 35 — the filter is PER OPPORTUNITY, not per organisation. This
 * returns one row per won opportunity, but it used to exclude on
 * `g.converted_at IS NULL`, a fact about the ORGANISATION. A business with
 * won deals on two products therefore had both rows disappear the moment
 * either one was confirmed: the second product's deal left the queue
 * silently, never linked, with nothing anywhere telling an operator it had
 * gone. Comparing the organisation's recorded `converted_product` against
 * THIS row's product means only the deal actually accounted for drops out.
 *
 * The asymmetry this leaves, stated plainly rather than papered over:
 * `converted_product`/`converted_ref`/`converted_at` live on
 * `crm_organisations`, so an organisation can hold exactly ONE recorded
 * conversion. The second product's deal now correctly stays in the queue —
 * and `linkConversion`'s Ruling 30 guard will refuse to link it, with the
 * operator-facing "already has a conversion recorded" message. That is a
 * visible, explainable refusal instead of a silent disappearance, which is
 * the trade this fix is making. The honest fix is to move `converted_*` onto
 * the opportunity, which is a schema change to a shipped design and
 * deliberately out of scope here; it is the thing to do if multi-product
 * conversions become common rather than theoretical.
 *
 * #214 — the `IS DISTINCT FROM` comparison KEEPS its place, now that
 * `linkConversion` fills a product-less won deal's `product` as it links it.
 * Reverting to a bare `g.converted_at IS NULL` was considered and rejected:
 * that is precisely the per-organisation test Ruling 35 replaced, and it
 * brings back the silent disappearance of a second product's won deal the
 * moment the first is confirmed. What #214 fixed was the other half of the
 * comparison — a null that no write ever cleared — not the comparison.
 *
 * Both branches are load-bearing, and neither is redundant. 0019's
 * `crm_org_conversion_complete` CHECK makes `converted_at` and
 * `converted_product` null together, so on a never-converted organisation
 * the comparison reads `NULL IS DISTINCT FROM o.product`, which is FALSE for
 * a product-less won deal — dropping the `converted_at IS NULL` branch would
 * hide the entire migrated backlog on day one, the exact bug this queue was
 * fixed for once already.
 */
export interface HandoffPage {
  readonly rows: readonly HandoffRow[];
  /**
   * There are won deals past `limit` that this page does not contain.
   *
   * Carried rather than left to the caller to infer from `rows.length ===
   * limit`, which is wrong exactly at the boundary: a queue of precisely
   * `limit` rows would claim there is more waiting when there is not, and an
   * operator who works the queue to empty would never see it go quiet.
   *
   * Discovered by asking for one row more than `limit` and discarding it —
   * one query, not a second COUNT. The instance is a shared db-f1-micro and
   * this queue's exact depth is not worth a second scan; "more are waiting"
   * is the whole decision an operator makes from it.
   */
  readonly hasMore: boolean;
}

export async function wonWithoutConversion(limit: number): Promise<HandoffPage> {
  const rows = await tesserixQuery<RawHandoffRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name, o.product, o.closed_at,
            c.email AS primary_email
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
       LEFT JOIN LATERAL (
         -- No erased_at test, unlike the primary-contact subqueries this
         -- ordering is otherwise shared with (see notErased()): erasure nulls
         -- the email, so the IS NOT NULL test already excludes an erased
         -- contact, and a second predicate here could only change this result
         -- if erasure stopped nulling it — at which point the erasure path,
         -- not this query, is the thing that broke.
         SELECT email FROM crm_contacts
          WHERE organisation_id = g.id AND email IS NOT NULL
          ORDER BY ${primaryContactOrder("")}
          LIMIT 1
       ) c ON true
      WHERE o.stage = 'won'
        -- A voided won deal is not waiting to be handed off (#251): the
        -- operator has said it should never have been won, so asking anyone
        -- to find its conversion is asking them to attribute a tenant to a
        -- deal that is on the record as a mistake. See linkConversion, which
        -- repeats this conjunct -- hiding the row here is not enough,
        -- because that function finds its won deal by organisation and
        -- product rather than from the row this queue handed out.
        AND ${notVoided("o")}
        AND (
          g.converted_at IS NULL
          OR g.converted_product IS DISTINCT FROM o.product
        )
      ORDER BY o.closed_at ASC NULLS LAST
      LIMIT $1`,
    // One more than asked for: the extra row is never rendered, it only
    // answers "is there anything past the cap".
    [limit + 1],
  );
  return {
    rows: rows.slice(0, limit).map(toHandoffRow),
    hasMore: rows.length > limit,
  };
}

export interface LinkConversionInput {
  organisationId: string;
  product: string;
  ref: string;
  label?: string;
  method: "matched" | "manual";
  /** Who confirmed the suggestion or typed the manual entry — carried
   *  through to the `crm_activities` row this write leaves (Ruling 31),
   *  same as `advanceStage`'s `actor`. */
  actor: string;
}

export interface LinkedConversion {
  organisationId: string;
  organisationName: string;
  product: string;
  method: "matched" | "manual";
}

/**
 * Thrown when `organisationId` already has a conversion recorded.
 *
 * Ruling 30: `wonWithoutConversion` returns one row per WON OPPORTUNITY, not
 * per organisation — a business with won deals on two products appears
 * twice in the handoff queue. Without a guard, confirming one row's
 * suggestion and then the other's would silently overwrite
 * `converted_product`/`converted_ref`/`converted_at` with the second
 * product's namespace: the exact cross-product attribution corruption this
 * whole design exists to prevent, reachable just by a stale tab or a second
 * operator working the same queue. Distinguished from "no such
 * organisation" (a plain not-found `Error`) so the operator sees an
 * accurate message rather than a report that the row vanished.
 */
export class AlreadyLinkedError extends Error {
  constructor(readonly organisationId: string) {
    super(`Organisation ${organisationId} already has a conversion recorded.`);
    this.name = "AlreadyLinkedError";
  }
}

/**
 * Link an organisation to a product's conversion.
 *
 * Never called for an unconfirmed suggestion — the caller (the action layer)
 * only reaches this after an operator has explicitly confirmed one, or typed
 * a conversion in by hand; `method` records which happened, so a bad
 * auto-link can never be indistinguishable from an operator's own decision.
 *
 * `product`/`ref` are validated here, together, before the UPDATE runs.
 * Migration 0019's `crm_org_conversion_complete` CHECK (both null or both
 * set) would refuse a half-supplied write anyway, but a raw
 * constraint-violation error reaching the operator is not this boundary's
 * job to produce when a clear message can be raised first.
 *
 * It also fills the won opportunity's `product` when that deal has none
 * (#214) — see the comment on that statement below. Every write here is one
 * transaction: organisation, opportunity, and timeline note land together or
 * not at all.
 *
 * The UPDATE and the `crm_activities` write both run inside `tesserixTx`
 * (Ruling 31), on one client: either both land or neither does. A
 * conversion that updated the organisation but left no note on its timeline
 * would be the single most significant moment in that business's life,
 * invisible to the next rep reading it — the timeline would still read
 * "won" with no sign handoff ever happened or who confirmed it.
 */
export async function linkConversion(input: LinkConversionInput): Promise<LinkedConversion> {
  const { organisationId, product, ref, label, method, actor } = input;
  if (!product.trim() || !ref.trim()) {
    throw new Error("linkConversion: both product and ref are required");
  }

  return tesserixTx(async (query) => {
    // `AND converted_at IS NULL` (Ruling 30): a row that already has a
    // conversion recorded is not a match for this UPDATE at all, so a
    // second confirmation — from a stale handoff-queue tab, or a second
    // operator — can never overwrite the first product's namespace.
    const rows = await query<{ id: string; name: string }>(
      `UPDATE crm_organisations
          SET converted_product = $2,
              converted_ref = $3,
              converted_label = $4,
              converted_at = now(),
              converted_link_method = $5,
              updated_at = now()
        WHERE id = $1
          AND converted_at IS NULL
        RETURNING id, name`,
      [organisationId, product, ref, label ?? null, method],
    );
    const row = rows[0];
    if (!row) {
      // Zero rows means either "no such organisation" or "already linked" —
      // resolved here, inside the same transaction, rather than leaving the
      // caller to guess which one a bare empty result meant.
      const existing = await query<{ id: string }>(
        `SELECT id FROM crm_organisations WHERE id = $1`,
        [organisationId],
      );
      if (existing.length === 0) {
        throw new Error(`linkConversion: organisation ${organisationId} not found`);
      }
      throw new AlreadyLinkedError(organisationId);
    }

    // The won deal this conversion is FOR. Ruling 31 put this note on the
    // timeline so the handoff is visible to the next rep reading the
    // record; without an `opportunity_id` it lands only on the
    // organisation, and the deal's own timeline — the one place a rep looks
    // to ask "what happened to this?" — still shows nothing after "won".
    // Null when no won opportunity carries this product and none could be
    // given it (a manual link for a product the organisation has no deal on
    // at all): the note is still worth writing at the organisation level,
    // and inventing an association with some other product's deal would be
    // worse than none.
    //
    // `AND voided_at IS NULL` is NOT redundant with `wonWithoutConversion`'s
    // own exclusion (#251). This lookup does not read the row the handoff
    // queue handed out — it re-finds a won deal from `organisation_id +
    // product + stage`. So hiding a voided won deal from the queue does not
    // stop it being selected here, by a manual link or by a suggestion
    // confirmed for the same organisation and product.
    //
    // WHAT THIS CONJUNCT DOES, AND WHAT IT DOES NOT. The organisation UPDATE
    // above has already run, and it takes `(organisationId, product, ref)`
    // alone — the deal selected here is not an input to it. So dropping this
    // conjunct changes neither the organisation's conversion nor whether
    // `AlreadyLinkedError` fires; what stops a voided deal being OFFERED for
    // linking is `wonWithoutConversion`, which keeps it out of the queue.
    // What this conjunct alone decides is where the Ruling 31 note lands — on
    // a deal declared never to have happened, or on the organisation only —
    // and, because a match here skips the backfill below, whether a live
    // product-less won deal gets its product written at all.
    //
    // The ORGANISATION still links when its only won deal is voided, and that
    // is deliberate: a conversion is a fact about the business, and businesses
    // convert without a CRM deal behind them. Do NOT "fix" this by moving the
    // void test above the organisation UPDATE — that would refuse a real
    // handoff, which is the opposite of the ruling.
    const opportunityRows = await query<{ id: string }>(
      `SELECT id FROM crm_opportunities
        WHERE organisation_id = $1 AND product = $2 AND stage = 'won'
          AND ${notVoided("")}
        ORDER BY closed_at DESC NULLS LAST
        LIMIT 1`,
      [organisationId, product],
    );

    // #214: the migrated backlog's exit from the handoff queue.
    //
    // A migrated won deal carries `product = NULL` — the backfill refuses to
    // invent attribution it never had (see `migrate-leads-to-crm.mjs`'s
    // header). Linking a conversion is the moment that attribution stops
    // being unknown: an operator has just said, on the record, which product
    // this deal became. Writing it here is what that decision means, and it
    // is also the only thing that lets the row leave `wonWithoutConversion`
    // — whose predicate compares the organisation's `converted_product`
    // against THIS opportunity's, and so kept matching a null forever.
    // Without it the row was linkable exactly once and clearable never,
    // erroring with `AlreadyLinkedError` on every retry after.
    //
    // Only ever fills a NULL, and only when no won deal already carries this
    // product (that deal is the one the conversion is for; a *different*
    // product-less deal on the same organisation is not, and stamping it
    // would fabricate exactly the attribution the migration declined to).
    // `updated_at` is set explicitly — there are no triggers on `crm_*`.
    //
    // Migration 0021 re-added `crm_opp_product_required_when_qualified`
    // (`stage IN ('new','contacted') OR product IS NOT NULL`) as NOT VALID,
    // so a grandfathered `won` row with a null product is un-updatable
    // UNLESS the same UPDATE supplies a product. This write supplies one:
    // it is precisely the update that CHECK was shaped to permit, which
    // `crm-repo.write.integration.test.ts` proves against a real database
    // rather than taking on trust.
    //
    // Oldest-closed-first when an organisation has several product-less won
    // deals, matching the queue's own ordering, so the row the operator was
    // looking at is the row that clears. Any others stay in the queue and
    // hit Ruling 30's guard — the same visible refusal a second product's
    // deal already gets, not a new failure mode.
    //
    // `AND voided_at IS NULL` in the inner SELECT, for the reason the lookup
    // above gives (#251) and one more of its own: this statement WRITES a
    // product onto the row it picks. Letting it pick a voided deal would
    // fabricate exactly the attribution the lead migration declined to
    // invent, onto a deal already declared a mistake, and would then hang
    // the conversion note off it.
    const filledRows =
      opportunityRows.length > 0
        ? []
        : await query<{ id: string }>(
            `UPDATE crm_opportunities
                SET product = $2,
                    updated_at = now()
              WHERE id = (
                SELECT id FROM crm_opportunities
                 WHERE organisation_id = $1
                   AND stage = 'won'
                   AND product IS NULL
                   AND ${notVoided("")}
                 ORDER BY closed_at ASC NULLS LAST, id ASC
                 LIMIT 1
              )
              RETURNING id`,
            [organisationId, product],
          );

    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
       VALUES ($1, $5, 'note', $2, $3, $4::jsonb)`,
      [
        organisationId,
        actor,
        `Linked to ${product} conversion ${ref}${label ? ` (${label})` : ""}`,
        JSON.stringify({ product, ref, label: label ?? null, method }),
        opportunityRows[0]?.id ?? filledRows[0]?.id ?? null,
      ],
    );

    return { organisationId: row.id, organisationName: row.name, product, method };
  });
}
