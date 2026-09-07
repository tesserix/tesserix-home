"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import type { EntitlementMatrix } from "@/lib/billing";
import { SINGLE_SOURCE, type CatalogSource } from "@/lib/billing/source-policy";
import {
  auditedOperation,
  type AuditDescription,
  type AuditableRefusal,
} from "@/lib/db/audit-repo";
import { writeEntitlements, type EntitlementRow } from "@/lib/db/plan-catalog-repo";
import { fetchProductEntitlements } from "@/lib/platform-api";

/**
 * The entitlement seed — tesserix-home#146, T4.
 *
 * Writes what mark8ly's plan gate ACTUALLY ENFORCES onto a catalog revision,
 * so the console has something to compare against rather than something it
 * typed out.
 *
 * # A server action, and not a script
 *
 * The plan for this task originally called for
 * `apps/console/scripts/seed-entitlements.ts`. It cannot be one.
 * `resolvePlatformApiToken` (`lib/auth/platform-token.ts`) is SESSION-BOUND:
 * it resolves the operator's own Zitadel token from their session and refresh
 * token, and a standalone process has neither and no way to mint either. There
 * is no machine credential for the console -> platform-api direction — mark8ly
 * -> console has one (`CONSOLE_CATALOG_CLIENT_ID`), and the reverse does not
 * exist.
 *
 * It is also what this codebase does anyway. Console mutations are server
 * actions without exception, and a write that skipped one would skip the audit
 * trail every sibling write produces.
 *
 * # A SIBLING of `actions.ts` and `promo-actions.ts`, not an addition to either
 *
 * The same reasoning `promo-actions.ts`'s header gives for being a sibling
 * rather than a caller: this surface's refusal wording is its own, and folding
 * a third vocabulary into a 900-line module would put a change to any of the
 * three in the others' blast radius. The wrapper below is `withDraftWrite`'s
 * three-part shape — session, capability inside `auditedOperation`, error
 * mapping — reproduced rather than shared, for the same reason.
 *
 * # DERIVED, NEVER TRANSCRIBED
 *
 * Not one feature name, plan name or cell value appears in this file. Every
 * one is read off the response, because the entire point of the table this
 * writes is to detect drift from the enforcement point — and a hand-typed
 * value makes it a copy of a copy that agrees with itself and with nothing
 * else. The two numbers that ARE here, {@link EXPECTED_FEATURES} and
 * {@link EXPECTED_PLANS}, are sizes rather than values; see their comment.
 */

export type EntitlementActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to edit the plan catalog.";

/** Internal error text — a driver message, a constraint body, a fetch failure
 *  — must never reach the operator verbatim. The same discipline
 *  `withDraftWrite`'s `NOT_SAVED_MESSAGE` applies. */
const NOT_SEEDED_MESSAGE = "The entitlements were not seeded.";

const CATALOG_SURFACE_PATH = "/platform/billing/catalog";

const SEED_ACTION = "billing.entitlements.seed";
const SEED_REFUSED_ACTION = "billing.entitlements.seed.refused";

/**
 * How complete a matrix has to be before ANY of it is written.
 *
 * These are the SIZES of 0052's two closed vocabularies — 26 features and 4
 * plans — and not a second copy of the vocabularies themselves. That split is
 * deliberate and is what keeps the derive rule intact: MEMBERSHIP is judged by
 * the database, whose CHECKs name every admissible feature and plan and refuse
 * anything else; COMPLETENESS cannot be judged there at all, because a
 * constraint sees one row and has no opinion about a row that never arrived.
 *
 * So the two guards compose: the counts here prove the product answered with a
 * whole matrix, 0052 proves every cell of it is a cell the console knows, and
 * together they mean a successful seed is exactly 104 known rows. Listing the
 * names here as well would be the fourth copy of the matrix — the thing this
 * task exists to avoid — and would drift from 0052 the first time a feature
 * is added.
 *
 * A number that has to move when 0052's CHECK moves is a small, visible cost;
 * a name list that can disagree with the CHECK silently is not.
 */
const EXPECTED_FEATURES = 26;
const EXPECTED_PLANS = 4;

/**
 * A refusal this action DECIDED, with a message written to be shown verbatim.
 *
 * `implements AuditableRefusal` (#409) for the reason `PublishRefused` does:
 * a refusal is a decision, and a decision worth making is worth a row. The
 * summary carries WHICH rule refused, so "how often does the product answer
 * with an incomplete matrix?" is a query rather than a grep — and an
 * incomplete matrix is precisely the condition an operator would otherwise
 * discover as unexplained parity drift weeks later.
 */
class EntitlementSeedRefused extends Error implements AuditableRefusal {
  constructor(
    message: string,
    private readonly rule: string,
    private readonly source: CatalogSource,
  ) {
    super(message);
    this.name = "EntitlementSeedRefused";
  }

  auditRefusal(): AuditDescription {
    return {
      action: SEED_REFUSED_ACTION,
      // Identifier-shaped keys set to `1`, not counts of anything —
      // `AuditSummary` has nowhere for a row to go, and `PublishRefused`
      // settles the shape.
      summary: {
        [`rule_${this.rule}`]: 1,
        [`source_${this.source}`]: 1,
      },
    };
  }
}

/**
 * Constraint name -> operator sentence.
 *
 * MATCHED ON THE CONSTRAINT, not on English, exactly as `PROMO_REFUSALS` is:
 * `pg` puts the violated constraint's name on the error, and 0052 names all
 * five of its rules so this mapping is possible. Nothing here re-checks a rule
 * before the write — the database is the rule, and a TypeScript pre-check is
 * one a future caller routes around. What this module owns is the WORDING.
 *
 * An unmatched constraint degrades to {@link NOT_SEEDED_MESSAGE}, so a
 * transport error or a rule a later migration adds cannot leak by omission.
 */
const SEED_REFUSALS: Readonly<Record<string, string>> = {
  plan_catalog_entitlements_pkey:
    "This revision already carries that product's entitlements. Seeding does not overwrite them — start a new revision, or discard this one first.",
  plan_catalog_entitlements_source_is_a_known_source:
    "That product is not one the console stores entitlements for.",
  plan_catalog_entitlements_plan_is_a_known_plan:
    "The product's matrix names a plan the console does not know. Its plan list and the console's have diverged, and the seed cannot be trusted until they agree.",
  plan_catalog_entitlements_feature_is_a_known_feature:
    "The product's matrix names a feature the console does not know. A feature was added to the plan gate and not to the console, and seeding it would store an entitlement that applies to nothing.",
  plan_catalog_entitlements_value_is_a_known_sentinel_or_cap:
    "The product's matrix carries a value the console cannot read: the only ones it admits are -2 and above (-2 negotiated, -1 unlimited, 0 disabled, and positive numbers as caps). A new sentinel was added to the plan gate and the console has not learned it yet.",
};

/** The constraint a driver error names, if it names one. `pg` sets
 *  `constraint`; the message carries the name too, and is read as the fallback
 *  so a wrapped or re-thrown error is still translated. */
function violatedConstraint(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  const named = (cause as { constraint?: unknown }).constraint;
  if (typeof named === "string" && named.length > 0) return named;
  const message = cause instanceof Error ? cause.message : "";
  return Object.keys(SEED_REFUSALS).find((name) => message.includes(name)) ?? null;
}

function seedRefusal(cause: unknown): string | null {
  const constraint = violatedConstraint(cause);
  return constraint === null ? null : (SEED_REFUSALS[constraint] ?? null);
}

/**
 * The wrapper: one capability, one audit row, one message vocabulary.
 *
 * The capability check runs INSIDE `operation`, so a `CapabilityError` reaches
 * `auditedOperation` and is written as a `capability.refused` row (#409)
 * instead of never entering the audit path — see `withDraftWrite`'s comment in
 * `actions.ts` for the full argument, including the decided consequence that
 * with no database this check never runs and the caller is told the write
 * failed rather than that they lack permission.
 */
async function withEntitlementWrite<T>(
  target: string,
  run: (actor: { sub: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = { sub: session?.sub ?? "unknown" };
    const value = await auditedOperation({
      actor: actor.sub,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "billing");
        return run(actor);
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    if (cause instanceof EntitlementSeedRefused) {
      return { ok: false, message: cause.message };
    }
    const refusal = seedRefusal(cause);
    if (refusal === null) {
      // An unrecognised cause is the one this branch cannot describe, so
      // discarding it would leave nobody able to say what happened — the same
      // reasoning `withPromoWrite` logs for.
      console.error(
        `[console] entitlement seed failed for ${target} — cause not recognised`,
        cause,
      );
    }
    return { ok: false, message: refusal ?? NOT_SEEDED_MESSAGE };
  }
}

/**
 * The one matrix this seed is about, or a refusal.
 *
 * # A `failures` entry is not an empty matrix
 *
 * It means the read DID NOT HAPPEN. Treating it as "this product entitles
 * nothing" would seed 104 zeroes — a policy nobody wrote — which would then
 * compare parity-clean against a gate that says otherwise, and the drift this
 * whole feature exists to surface would be invisible from its first day. So a
 * failure naming this source refuses, and it refuses even when a matrix for
 * the source is ALSO present: a product that answered partially answered
 * nothing a seed can rely on.
 *
 * # Selected by source, never positionally
 *
 * `data` is a list of per-product matrices that are federated and never
 * merged, because a feature vocabulary is per-product — `stores` is mark8ly's
 * word about mark8ly's gate. `data[0]` is whichever product answered first.
 */
function matrixFor(
  page: import("@/lib/billing").EntitlementPage,
  source: CatalogSource,
): EntitlementMatrix {
  const failure = page.failures.find((entry) => entry.source === source);
  if (failure) {
    throw new EntitlementSeedRefused(
      `${source} could not be read, so there is nothing to seed from. This is not the same as ${source} entitling nothing, and no rows were written. Try again once the product is answering.`,
      "source_failed",
      source,
    );
  }
  const matrix = page.data.find((entry) => entry.source === source);
  if (!matrix) {
    throw new EntitlementSeedRefused(
      `No product called ${source} answered with a plan-feature matrix, so there is nothing to seed from.`,
      "source_absent",
      source,
    );
  }
  return matrix;
}

/**
 * Every cell of the matrix, as rows — or a refusal, having written nothing.
 *
 * # Refuse rather than partially seed
 *
 * A short matrix is rejected before a single row is written, and the three
 * checks below are three different ways of being short:
 *
 *   - fewer features than 0052 knows,
 *   - fewer plans than 0052 knows,
 *   - a plan whose map does not carry every declared feature — the case the
 *     first two miss, and the reason the third exists. A response can declare
 *     26 features, carry 4 plans, and hold 25 cells in one of them; the counts
 *     both pass and 103 rows go in.
 *
 * All three matter for one reason: a partial seed later compares as AGREEMENT
 * on the rows that exist and is SILENT about the rows that do not. An empty
 * table is visibly unseeded. A 103-row table is not visibly anything, and the
 * missing cell is exactly where an entitlement nobody checked would live.
 *
 * `>=`, not `===`, on the counts: a product that gates MORE than the console
 * knows about is not a short read, and the rows it sends are judged one by one
 * by 0052's CHECKs — which is where an unknown feature is refused, by name,
 * with a sentence in {@link SEED_REFUSALS}.
 */
function rowsFrom(matrix: EntitlementMatrix, source: CatalogSource): EntitlementRow[] {
  const refuse = (message: string, rule: string): never => {
    throw new EntitlementSeedRefused(
      `${message} Nothing was written: a partly seeded revision would agree with the plan gate on the rows it has and say nothing about the rows it does not.`,
      rule,
      source,
    );
  };

  const planNames = Object.keys(matrix.plans);
  if (matrix.features.length < EXPECTED_FEATURES) {
    refuse(
      `${source} reported ${matrix.features.length} features and the console expects at least ${EXPECTED_FEATURES}.`,
      "short_feature_list",
    );
  }
  if (planNames.length < EXPECTED_PLANS) {
    refuse(
      `${source} reported ${planNames.length} plans and the console expects at least ${EXPECTED_PLANS}.`,
      "short_plan_list",
    );
  }

  const rows: EntitlementRow[] = [];
  for (const plan of planNames) {
    const cells = matrix.plans[plan];
    for (const feature of matrix.features) {
      const value = cells[feature];
      // `undefined`, never `!value` — `0` is Disabled AND the zero value, so a
      // falsy test would read every disabled cell as a missing one and refuse
      // every complete matrix there has ever been.
      if (value === undefined) {
        refuse(
          `${source}'s ${plan} plan is missing a value for ${feature}, which its own feature list declares.`,
          "incomplete_plan",
        );
      }
      rows.push({ plan, feature, value });
    }
  }
  return rows;
}

/**
 * Seed one revision with what a product's plan gate enforces.
 *
 * The revision is the caller's: entitlements hang off `plan_catalog_revisions`
 * so that an entitlement change is versioned and published by the same
 * machinery a price change is, and choosing WHICH revision is a decision this
 * function has no basis to make.
 *
 * It does not overwrite. 0052's primary key refuses a second seed onto a
 * revision that already carries this product's rows, `writeEntitlements`
 * carries no `ON CONFLICT`, and {@link SEED_REFUSALS} turns that into a
 * sentence — because a re-seed is not an idempotent re-run, it is a caller who
 * does not know what is already there.
 */
export async function seedEntitlementsAction(
  revisionId: string,
  source: CatalogSource = SINGLE_SOURCE,
): Promise<EntitlementActionResult> {
  const result = await withEntitlementWrite(
    revisionId,
    async () => {
      const page = await fetchProductEntitlements(source);
      const rows = rowsFrom(matrixFor(page, source), source);
      await writeEntitlements(revisionId, source, rows);
      return rows.length;
    },
    (seeded) => ({
      action: SEED_ACTION,
      summary: { seeded },
      target: revisionId,
    }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}
