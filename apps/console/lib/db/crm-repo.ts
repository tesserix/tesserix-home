/**
 * The CRM repository barrel.
 *
 * This file used to BE the CRM repository — 3,612 lines against an 800-line
 * ceiling (#566). The code now lives in the modules re-exported below; this
 * file is the stable import path they are reached through.
 *
 * IT IS DELIBERATELY STILL HERE. 41 files import from `@/lib/db/crm-repo`,
 * and roughly 6,100 lines of tests do too. Keeping the barrel is what made
 * the split verifiable as a pure refactor: not one importer and not one test
 * changed, so nothing about what these functions do could have moved with
 * them. Point new imports at the module that owns the symbol if you prefer,
 * but do not "finish the job" by deleting this file and rewriting 41 call
 * sites — that trade buys nothing and gives up the guarantee.
 *
 * The re-exports are named rather than `export *` so that the module each
 * symbol belongs to is readable from here.
 *
 * Note what is NOT re-exported: the shared SQL fragments in `crm-sql.ts`
 * (`primaryContactOrder`, `notErased`, `notVoided`, the follower clauses) and
 * the row coercions in `crm-row.ts`. Those were module-private before the
 * split and stay private to the repository layer.
 */

export {
  CLOCK_ELIGIBLE_SQL,
  OUTBOUND_RESCHEDULES_SQL,
  nextActionAssignment,
} from "./crm-sql";

export {
  type QueueFilter,
  type QueueRow,
  type Page,
  type QueuePage,
  dueOpportunities,
  driftingOpportunities,
  type ClosedRow,
  type ClosedPage,
  closedOpportunities,
} from "./crm-queue-repo";

export {
  MissingProductError,
  VoidedOpportunityError,
  type AdvanceStageInput,
  type AdvanceStageResult,
  advanceStage,
  advanceStageOnQuery,
  type SetNextActionInput,
  setNextAction,
  type LogActivityInput,
  SuppressedContactError,
  logActivity,
  assertNoSuppressedContact,
} from "./crm-write-repo";

export {
  type OrganisationRow,
  type ContactRow,
  type OpportunityRow,
  type ActivityRow,
  type OrganisationDetail,
  ACTIVITY_LIMIT,
  organisationDetail,
} from "./crm-organisation-repo";

export {
  type SuppressionRow,
  type SuppressionCheck,
  isSuppressed,
  type AddSuppressionInput,
  addSuppression,
  listSuppressions,
  type RemovedSuppression,
  removeSuppression,
  normalizeInstagramHandle,
} from "./crm-suppressions-repo";

export {
  findMatchingOrganisationId,
  ErasureCheckUnavailableError,
  isErased,
  type ImportPreview,
  previewImport,
  type ImportResult,
  commitImport,
} from "./crm-import-repo";

export {
  type HandoffRow,
  type HandoffPage,
  wonWithoutConversion,
  type LinkConversionInput,
  type LinkedConversion,
  AlreadyLinkedError,
  linkConversion,
} from "./crm-handoff-repo";

export {
  type OrganisationFilter,
  type OrganisationListRow,
  type OrganisationPage,
  ORGANISATION_SORTS,
  type OrganisationSortKey,
  type SortDirection,
  type OrganisationSort,
  UnknownSortKeyError,
  type ListOrganisationsOptions,
  listOrganisations,
} from "./crm-browse-repo";
