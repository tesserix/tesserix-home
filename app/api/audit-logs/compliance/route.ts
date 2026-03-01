import { NextResponse } from 'next/server';
import { adminFetch, getSessionContext, apiError } from '@/lib/api/admin-fetch';

/**
 * GET /api/audit-logs/compliance
 *
 * Aggregates compliance reports across all tenants for platform admins.
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
        generated_at: new Date().toISOString(),
        period_start: new Date(Date.now() - 90 * 86400000).toISOString(),
        period_end: new Date().toISOString(),
        total_events: 0,
        data_access_events: 0,
        admin_actions: 0,
        security_events: 0,
        compliance_score: 100,
        findings: [],
      });
    }

    // Fetch compliance reports from each tenant in parallel
    const reportPromises = tenants.map(async (tenant: { tenant_id?: string; id?: string }) => {
      const tid = tenant.tenant_id || tenant.id || '';
      try {
        const response = await adminFetch('audit', '/audit-logs/compliance/report', {
          tenantId: tid,
        });

        if (!response.ok) return null;
        return response.json();
      } catch {
        return null;
      }
    });

    const reports = (await Promise.all(reportPromises)).filter(Boolean);

    if (reports.length === 0) {
      return NextResponse.json({
        generated_at: new Date().toISOString(),
        period_start: new Date(Date.now() - 90 * 86400000).toISOString(),
        period_end: new Date().toISOString(),
        total_events: 0,
        data_access_events: 0,
        admin_actions: 0,
        security_events: 0,
        compliance_score: 100,
        findings: [],
      });
    }

    // Aggregate compliance reports
    const aggregated = {
      generated_at: new Date().toISOString(),
      period_start: reports[0].period_start || new Date(Date.now() - 90 * 86400000).toISOString(),
      period_end: reports[0].period_end || new Date().toISOString(),
      total_events: 0,
      data_access_events: 0,
      admin_actions: 0,
      security_events: 0,
      compliance_score: 0,
      findings: [] as Array<{ severity: string; category: string; description: string; recommendation: string }>,
    };

    let scoreSum = 0;
    for (const report of reports) {
      aggregated.total_events += report.total_events || 0;
      aggregated.data_access_events += report.data_access_events || 0;
      aggregated.admin_actions += report.admin_actions || 0;
      aggregated.security_events += report.security_events || 0;
      scoreSum += report.compliance_score || 0;

      if (Array.isArray(report.findings)) {
        aggregated.findings.push(...report.findings);
      }
    }

    aggregated.compliance_score = Math.round(scoreSum / reports.length);

    return NextResponse.json(aggregated);
  } catch (error) {
    console.error('[Audit Compliance API] Error:', error);
    return apiError('Failed to fetch compliance report');
  }
}
