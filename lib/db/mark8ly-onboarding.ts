// Onboarding funnel queries against mark8ly_platform_api.onboarding_sessions.
// Three stages of the funnel:
//   1. Started        — row exists
//   2. Email verified — email_verified_at IS NOT NULL
//   3. Completed      — status = 'completed' OR completed_at IS NOT NULL
//
// "Abandoned" is a derived bucket: not completed AND no activity in 7 days.
// Read-only — these queries never write to the mark8ly DB.

import { mark8lyQuery } from "./mark8ly";

export interface OnboardingFunnelStats {
  readonly totalStarted: number;
  readonly emailVerified: number;
  readonly completed: number;
  readonly inFlight: number;
  readonly abandoned: number;
  /** Median seconds from row creation to status='completed'. Null when no completed sessions. */
  readonly medianTimeToCompleteSeconds: number | null;
  /** Last 24 hours: started, completed, abandoned. */
  readonly last24h: {
    readonly started: number;
    readonly completed: number;
  };
}

export interface OnboardingSessionRow {
  readonly id: string;
  readonly email: string;
  readonly business_name: string | null;
  readonly status: string;
  readonly email_verified_at: string | null;
  readonly completed_at: string | null;
  readonly tenant_id: string | null;
  readonly last_activity_at: string;
  readonly created_at: string;
  /** Derived flag: hasn't been active in 7 days and isn't completed. */
  readonly is_abandoned: boolean;
  /** Hours since last activity. */
  readonly hours_idle: number;
}

const ABANDONED_AFTER_DAYS = 7;

export async function getOnboardingFunnelStats(): Promise<OnboardingFunnelStats> {
  // Single round trip — five aggregates in one CTE so the connection is
  // held briefly even when the table grows large.
  const sql = `
    WITH base AS (
      SELECT status, email_verified_at, completed_at, last_activity_at, created_at
      FROM onboarding_sessions
    )
    SELECT
      count(*)::bigint                                                   AS total_started,
      count(*) FILTER (WHERE email_verified_at IS NOT NULL)::bigint      AS email_verified,
      count(*) FILTER (WHERE status = 'completed')::bigint               AS completed,
      count(*) FILTER (WHERE status <> 'completed'
                       AND last_activity_at > now() - interval '${ABANDONED_AFTER_DAYS} days')::bigint AS in_flight,
      count(*) FILTER (WHERE status <> 'completed'
                       AND last_activity_at <= now() - interval '${ABANDONED_AFTER_DAYS} days')::bigint AS abandoned,
      EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY (completed_at - created_at)))
        FILTER (WHERE completed_at IS NOT NULL)                          AS median_time_to_complete_seconds,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::bigint   AS started_24h,
      count(*) FILTER (WHERE completed_at IS NOT NULL
                       AND completed_at > now() - interval '24 hours')::bigint  AS completed_24h
    FROM base
  `;
  const res = await mark8lyQuery<{
    total_started: string;
    email_verified: string;
    completed: string;
    in_flight: string;
    abandoned: string;
    median_time_to_complete_seconds: string | null;
    started_24h: string;
    completed_24h: string;
  }>("platform_api", sql);
  const r = res.rows[0];
  return {
    totalStarted: Number(r?.total_started ?? 0),
    emailVerified: Number(r?.email_verified ?? 0),
    completed: Number(r?.completed ?? 0),
    inFlight: Number(r?.in_flight ?? 0),
    abandoned: Number(r?.abandoned ?? 0),
    medianTimeToCompleteSeconds: r?.median_time_to_complete_seconds
      ? Math.round(Number(r.median_time_to_complete_seconds))
      : null,
    last24h: {
      started: Number(r?.started_24h ?? 0),
      completed: Number(r?.completed_24h ?? 0),
    },
  };
}

export interface ListSessionsFilter {
  readonly status?: "in_flight" | "completed" | "abandoned" | "all";
  readonly limit?: number;
}

export async function listOnboardingSessions(
  filter: ListSessionsFilter = {},
): Promise<OnboardingSessionRow[]> {
  const status = filter.status ?? "in_flight";
  const limit = Math.min(filter.limit ?? 200, 500);

  const where: string[] = [];
  const params: unknown[] = [];
  if (status === "in_flight") {
    where.push(
      `(status <> 'completed' AND last_activity_at > now() - interval '${ABANDONED_AFTER_DAYS} days')`,
    );
  } else if (status === "abandoned") {
    where.push(
      `(status <> 'completed' AND last_activity_at <= now() - interval '${ABANDONED_AFTER_DAYS} days')`,
    );
  } else if (status === "completed") {
    where.push(`status = 'completed'`);
  }
  // "all" → no filter

  const sql = `
    SELECT
      id::text,
      email,
      draft->>'business_name'              AS business_name,
      status,
      email_verified_at,
      completed_at,
      tenant_id::text,
      last_activity_at,
      created_at,
      (status <> 'completed' AND last_activity_at <= now() - interval '${ABANDONED_AFTER_DAYS} days') AS is_abandoned,
      EXTRACT(EPOCH FROM (now() - last_activity_at)) / 3600.0           AS hours_idle
    FROM onboarding_sessions
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY last_activity_at DESC
    LIMIT ${limit}
  `;
  const res = await mark8lyQuery<{
    id: string;
    email: string;
    business_name: string | null;
    status: string;
    email_verified_at: string | null;
    completed_at: string | null;
    tenant_id: string | null;
    last_activity_at: string;
    created_at: string;
    is_abandoned: boolean;
    hours_idle: string;
  }>("platform_api", sql, params);

  return res.rows.map((r) => ({
    id: r.id,
    email: r.email,
    business_name: r.business_name,
    status: r.status,
    email_verified_at: r.email_verified_at,
    completed_at: r.completed_at,
    tenant_id: r.tenant_id,
    last_activity_at: r.last_activity_at,
    created_at: r.created_at,
    is_abandoned: r.is_abandoned,
    hours_idle: Math.round(Number(r.hours_idle ?? 0)),
  }));
}
