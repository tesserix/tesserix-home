import { NextResponse } from 'next/server';
import { adminFetch, getSessionContext, apiError } from '@/lib/api/admin-fetch';

/**
 * GET /api/audit-logs/summary
 *
 * Aggregates audit log summaries across all tenants for platform admins.
 */
export async function GET() {
  try {
    const session = await getSessionContext();
    if (!session) {
      return apiError('Unauthorized', 401);
    }

    // Fetch all tenant IDs
    const tenantsResponse = await adminFetch('tenant', '/api/v1/users/me/tenants?limit=100');
    if (!tenantsResponse.ok) {
      return apiError('Failed to fetch tenants', tenantsResponse.status);
    }

    const tenantsBody = await tenantsResponse.json();
    const tenantsNested = tenantsBody?.data;
    const tenants = Array.isArray(tenantsNested?.tenants)
      ? tenantsNested.tenants
      : Array.isArray(tenantsNested) ? tenantsNested : [];

    if (tenants.length === 0) {
      return NextResponse.json({
        total_events: 0,
        critical_events: 0,
        failed_auth_attempts: 0,
        events_today: 0,
        events_by_severity: {},
        events_by_action: {},
      });
    }

    // Fetch summaries from each tenant in parallel
    const summaryPromises = tenants.map(async (tenant: { tenant_id?: string; id?: string }) => {
      const tid = tenant.tenant_id || tenant.id || '';
      try {
        const response = await adminFetch('audit', '/audit-logs/summary', {
          tenantId: tid,
        });

        if (!response.ok) return null;
        return response.json();
      } catch {
        return null;
      }
    });

    const summaries = (await Promise.all(summaryPromises)).filter(Boolean);

    // Aggregate summaries
    const aggregated = {
      total_events: 0,
      critical_events: 0,
      failed_auth_attempts: 0,
      events_today: 0,
      events_by_severity: {} as Record<string, number>,
      events_by_action: {} as Record<string, number>,
    };

    for (const s of summaries) {
      // The Go service returns nested structures; handle both flat and nested
      const data = s.summary || s;
      aggregated.total_events += data.total_logs || data.total_events || 0;
      aggregated.events_today += data.events_today || 0;

      // Count critical from severity breakdown or direct field
      if (data.critical_events !== undefined) {
        aggregated.critical_events += data.critical_events;
      }

      if (data.failed_auth_attempts !== undefined) {
        aggregated.failed_auth_attempts += data.failed_auth_attempts;
      }

      // Aggregate by_severity
      const bySeverity = data.by_severity || data.events_by_severity || data.severity_counts || {};
      for (const [severity, count] of Object.entries(bySeverity)) {
        const c = typeof count === 'number' ? count : 0;
        aggregated.events_by_severity[severity] = (aggregated.events_by_severity[severity] || 0) + c;
        if (severity === 'CRITICAL') {
          aggregated.critical_events += c;
        }
      }

      // Aggregate by_action
      const byAction = data.by_action || data.events_by_action || data.action_counts || {};
      for (const [act, count] of Object.entries(byAction)) {
        const c = typeof count === 'number' ? count : 0;
        aggregated.events_by_action[act] = (aggregated.events_by_action[act] || 0) + c;
        // Count failed auth from action breakdown
        if (act.toLowerCase().includes('login_failed') || act.toLowerCase().includes('auth_failed')) {
          aggregated.failed_auth_attempts += c;
        }
      }
    }

    return NextResponse.json(aggregated);
  } catch (error) {
    console.error('[Audit Summary API] Error:', error);
    return apiError('Failed to fetch audit summary');
  }
}
