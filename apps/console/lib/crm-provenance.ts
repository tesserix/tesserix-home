/**
 * Contact provenance (#248): the closed vocabulary behind
 * `crm_contacts.source`, `.sourced_at` and `.lawful_basis`.
 *
 * Migration 0019 states why those three columns exist, on the table itself:
 * "we hold scraped social profiles about people who never filled in a form.
 * `source`/`sourced_at`/`lawful_basis` record what we hold and why." That is
 * the justification for holding the data at all — but until #248 the only
 * writer of any of them was the one-shot leads migration script, so every
 * contact created by import or by hand carried none.
 *
 * The columns are plain `text` with no CHECK, exactly like
 * `crm_opportunities.product`, and this module is validated at the write
 * boundaries for exactly the reason `ESTATE_CONTEXTS` is: a typo written
 * once is what a subject-access request is later answered from. The
 * validation lives in TypeScript rather than in a Postgres CHECK for the
 * same reason `product`'s does — the legacy value below must stay storable
 * while never being offered, and a CHECK cannot express "valid to keep,
 * invalid to choose".
 */

/** A lawful basis, as stored in `crm_contacts.lawful_basis`. */
export type LawfulBasis =
  | "legitimate_interests"
  | "consent"
  | "contract"
  | "dpdp_public_data_exempt"
  | "not_recorded_pre_migration";

export interface LawfulBasisOption {
  value: LawfulBasis;
  label: string;
  /** What the operator is claiming by choosing it. Shown next to the option
   *  rather than left to a runbook: the choice is the compliance artefact,
   *  and an operator picking blind produces a column that looks recorded and
   *  evidences nothing. */
  description: string;
}

/**
 * The bases an operator may choose for a contact being created or corrected
 * now. `not_recorded_pre_migration` is deliberately absent — see
 * `LEGACY_LAWFUL_BASIS`.
 */
export const SELECTABLE_LAWFUL_BASES: readonly LawfulBasisOption[] = [
  {
    value: "legitimate_interests",
    label: "Legitimate interests",
    description:
      "A business profile we sourced ourselves for B2B outreach. The usual basis for an import of scraped contacts.",
  },
  {
    value: "consent",
    label: "Consent",
    description: "The person opted in — a form fill, a signup, an explicit request to be contacted.",
  },
  {
    value: "contract",
    label: "Contract",
    description: "An existing customer relationship we hold their details to service.",
  },
  {
    value: "dpdp_public_data_exempt",
    label: "DPDP — publicly available data",
    description:
      "India only. The person published these details themselves, so India's DPDP Act does not apply to them (s.3(c)(ii)). Not for EU/UK contacts — the GDPR has no equivalent carve-out.",
  },
];

/**
 * `dpdp_public_data_exempt` IS NOT A LAWFUL BASIS EITHER, and the column
 * holding it is still the right place for it.
 *
 * The other three values answer "under which of the Act's bases do we hold
 * this?". This one answers "the Act does not reach this data at all" —
 * India's DPDP s.3(c)(ii) excludes personal data the data principal has
 * themselves made publicly available. That is a different kind of claim, and
 * `lawful_basis` already carries a value of that kind: `LEGACY_LAWFUL_BASIS`
 * is an admission rather than a basis, kept storable for the same reason.
 * One column recording "why we are entitled to hold this row" is what a
 * subject-access request is answered from; splitting the exemption into a
 * second column would mean the answer lives in two places and a reader has
 * to know to check both.
 *
 * WHY IT EXISTS AT ALL. The 259 migrated contacts were relabelled to
 * `legitimate_interests` by the #248 backfill. That was wrong, and wrong in a
 * way worth naming: legitimate interests is a GDPR Art 6(1)(f) concept, and
 * DPDP has no counterpart. Its section 4 offers consent or the closed list of
 * "certain legitimate uses" in section 7, which does not include business
 * development, and it provides no balancing test to fall back on. So the old
 * label asserted a justification that does not exist in the statute that
 * governs those contacts.
 *
 * WHY IT IS SELECTABLE. Unlike the legacy marker this is a forward-looking
 * determination an operator can correctly make, so refusing it would leave
 * the only honest label for an Indian scraped contact unavailable. The
 * India-only limit is stated in the description rather than enforced in code:
 * `crm_organisations.country` is NULL for most rows (migration 0025 records
 * 208 of 259), so a country-conditional guard would reject the very contacts
 * it exists to serve. See `docs/LIA-CRM-OUTREACH-2026-10.md` §6.
 */
export const DPDP_PUBLIC_DATA_EXEMPT = "dpdp_public_data_exempt" as const;

/**
 * The marker the May-2026 leads migration wrote, and the value every one of
 * the 259 contacts in production carries today.
 *
 * It is NOT a lawful basis. It is an honest admission that the basis was
 * never recorded, kept valid so those rows stay readable and so
 * `crm-erasure.ts` — which leaves all three provenance columns intact by
 * design — has nothing to reconcile. It is excluded from
 * `SELECTABLE_LAWFUL_BASES` because offering it would let an operator record
 * "we do not know" as a forward-looking choice, which is the failure #248
 * exists to close, not a case to preserve.
 */
export const LEGACY_LAWFUL_BASIS = "not_recorded_pre_migration" as const;

const LEGACY_LAWFUL_BASIS_LABEL = "Not recorded (pre-migration)";

const SELECTABLE_VALUES: ReadonlySet<string> = new Set(
  SELECTABLE_LAWFUL_BASES.map((basis) => basis.value),
);

/**
 * True for a basis an operator may CHOOSE. This is the check every write
 * boundary makes — `commitImportAction`, `createOrganisationAction`,
 * `addContactAction`, `updateContactAction` — and the reason
 * `not_recorded_pre_migration` cannot be written by any live path.
 */
export function isSelectableLawfulBasis(value: unknown): value is LawfulBasis {
  return typeof value === "string" && SELECTABLE_VALUES.has(value);
}

/**
 * True for any basis the column may legitimately HOLD, legacy marker
 * included. Read-side only: rendering and reasoning about an existing row.
 * Never use it to admit a write — that is `isSelectableLawfulBasis`.
 */
export function isStoredLawfulBasis(value: unknown): value is LawfulBasis {
  return value === LEGACY_LAWFUL_BASIS || isSelectableLawfulBasis(value);
}

/** The refusal a boundary returns for a basis outside the set. Names the
 *  value so an operator (or a direct caller of the server action) can see
 *  what was rejected, without echoing it back as markup. */
export function unknownLawfulBasisMessage(value: string): string {
  return `"${value}" is not a lawful basis a contact can be recorded under.`;
}

/** The refusal when a write path supplied none at all. A contact with no
 *  basis is the exact defect #248 reports, so it is refused rather than
 *  defaulted: a silent default makes the column decorative. */
export const LAWFUL_BASIS_REQUIRED_MESSAGE = "Choose a lawful basis for holding this contact's details.";

/**
 * How a lawful basis reads on screen. Falls back to the raw value rather
 * than to "unknown" — a row holding something this build does not know
 * about is a fact worth showing verbatim, not one worth hiding.
 */
export function lawfulBasisLabel(value: string | null): string {
  if (value === null) return "Not recorded";
  if (value === LEGACY_LAWFUL_BASIS) return LEGACY_LAWFUL_BASIS_LABEL;
  return SELECTABLE_LAWFUL_BASES.find((basis) => basis.value === value)?.label ?? value;
}

/**
 * `crm_contacts.source` — WHICH WRITE PATH produced the row, not which batch.
 *
 * The batch is already recorded: `commitImport` stamps every organisation it
 * creates with `crm_organisations.import_id`, and a contact hangs off an
 * organisation, so "which import produced this contact" is a join away and
 * needs no second copy here. Putting a uuid in this column instead would
 * make the one provenance field an operator reads during a subject-access
 * request an opaque identifier, and would disagree with every value already
 * in the table — production's 259 rows say `instagram_outreach`, and
 * `crm_opportunities.source` already says `'import'` for exactly this path.
 * A vocabulary word, matching what is there.
 */
export const CONTACT_SOURCE = {
  /** Created by a CSV batch through `commitImport`. */
  import: "import",
  /** Typed in by an operator — the manual-create door (`crm-writes.ts`). */
  manual: "manual",
} as const;

export type ContactSource = (typeof CONTACT_SOURCE)[keyof typeof CONTACT_SOURCE];

const CONTACT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  [CONTACT_SOURCE.import]: "CSV import",
  [CONTACT_SOURCE.manual]: "Added by hand",
  instagram_outreach: "Instagram outreach",
};

/** How a source reads on screen. Unknown values — anything a later script or
 *  an earlier era wrote — are shown verbatim for the same reason
 *  `lawfulBasisLabel` shows them: the record is the answer to a subject
 *  request, and a label this build lacks is not grounds to withhold it. */
export function contactSourceLabel(value: string | null): string {
  if (value === null) return "Not recorded";
  return CONTACT_SOURCE_LABELS[value] ?? value;
}
