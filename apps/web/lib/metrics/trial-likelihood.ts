// Trial→paid conversion likelihood. Heuristic, not ML. Output bucket
// (low/medium/high) is shown as a tag on the subscriptions list and on
// the tenant detail page when the tenant is in trial. Surfaced as
// "heuristic" in tooltips so it isn't treated as a prediction.
//
// Score blends three signals:
//   - days into trial — later = higher likelihood (capped at 0.7)
//   - has activity (orders > 0) — boost +0.2
//   - recent login (last 7d) — boost +0.1
// Sum bucketed at thresholds: <0.4 low | <0.7 medium | else high.

export type TrialLikelihood = "low" | "medium" | "high";

export interface TrialSignals {
  readonly daysIntoTrial: number;
  readonly orderCount: number;
  readonly lastSeenAt?: Date | null;
}

const TYPICAL_TRIAL_DAYS = 14;

export function scoreTrialLikelihood(signals: TrialSignals): TrialLikelihood {
  const ageScore = Math.min(0.7, signals.daysIntoTrial / TYPICAL_TRIAL_DAYS * 0.7);
  const activityScore = signals.orderCount > 0 ? 0.2 : 0;
  const recencyScore = recentlySeen(signals.lastSeenAt) ? 0.1 : 0;
  const total = ageScore + activityScore + recencyScore;

  if (total < 0.4) return "low";
  if (total < 0.7) return "medium";
  return "high";
}

function recentlySeen(lastSeenAt: Date | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const ms = Date.now() - lastSeenAt.getTime();
  return ms < 7 * 24 * 60 * 60 * 1000;
}

export function daysIntoTrial(createdAt: string | Date): number {
  const start = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const ms = Date.now() - start.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

export function trialDaysRemaining(currentPeriodEnd: string | null | undefined): number | null {
  if (!currentPeriodEnd) return null;
  const end = new Date(currentPeriodEnd);
  const ms = end.getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
