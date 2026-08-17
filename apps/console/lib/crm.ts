/** Pipeline order. `won`/`lost` are terminal. */
export const CRM_STAGES = ["new", "contacted", "qualified", "won", "lost"] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export const CRM_ACTIVITY_KINDS = [
  "note", "dm_sent", "dm_received", "email_sent", "email_received",
  "call", "stage_change", "assigned",
] as const;
export type CrmActivityKind = (typeof CRM_ACTIVITY_KINDS)[number];

/**
 * The kinds an operator may author directly, through a free-text note/log
 * action. `stage_change` and `assigned` are system-authored: they are
 * written only by the code that performs the thing they describe
 * (`advanceStage`, an owner-assignment write), each inside the same
 * transaction as that change. A generic "log an activity" action that
 * accepted every kind could write a `stage_change` row with an arbitrary
 * body and no stage having moved — the timeline that funnel measurement
 * reads would then no longer be solely produced by `advanceStage`, which is
 * the whole guarantee that function exists to hold.
 */
export const HUMAN_ACTIVITY_KINDS = [
  "note", "dm_sent", "dm_received", "email_sent", "email_received", "call",
] as const satisfies readonly CrmActivityKind[];
export type HumanActivityKind = (typeof HUMAN_ACTIVITY_KINDS)[number];

export function isCrmStage(value: string): value is CrmStage {
  return (CRM_STAGES as readonly string[]).includes(value);
}

export function isCrmActivityKind(value: string): value is CrmActivityKind {
  return (CRM_ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isHumanActivityKind(value: string): value is HumanActivityKind {
  return (HUMAN_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** `product` is required from `qualified` onward. Mirrors the CHECK constraint
 *  in migration 0019 so the boundary rejects before the database has to. */
export function requiresProduct(stage: CrmStage): boolean {
  return stage !== "new" && stage !== "contacted";
}

/** Days of silence before a no-next-action opportunity counts as "drifting"
 *  in the queue. A guess about sales rhythm, not a measured threshold — there
 *  is no usage data yet. Revisit once real queues exist to tune against. */
export const DRIFT_DAYS = 14;
