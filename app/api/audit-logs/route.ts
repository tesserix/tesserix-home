import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, getSessionContext, apiError } from '@/lib/api/admin-fetch';

/**
 * GET /api/audit-logs
 *
 * For platform admins: aggregates audit logs across all tenants.
 * Fetches tenant list, then queries audit-service for each tenant in parallel.
 *
 * Query params: search, severity, action, start_date, end_date, page, limit
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const severity = searchParams.get('severity');
    const search = searchParams.get('search');
    const action = searchParams.get('action');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

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
      return NextResponse.json([]);
    }

    // Build query params for audit-service
    const auditParams = new URLSearchParams({ limit: '100', offset: '0' });
    if (severity) auditParams.set('severity', severity);
    if (action) auditParams.set('action', action);
    if (search) auditParams.set('search', search);
    if (startDate) auditParams.set('from_date', startDate);
    if (endDate) auditParams.set('to_date', endDate);

    // Fetch audit logs from each tenant in parallel
    const logPromises = tenants.map(async (tenant: { tenant_id?: string; id?: string; name?: string; slug?: string }) => {
      const tid = tenant.tenant_id || tenant.id || '';
      try {
        const response = await adminFetch('audit', `/audit-logs?${auditParams}`, {
          tenantId: tid,
        });

        if (!response.ok) return [];

        const data = await response.json();
        const logs = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
        // Attach tenant info
        return logs.map((log: Record<string, unknown>) => ({
          ...log,
          tenant_id: tid,
          tenant_name: tenant.name || tenant.slug || tid,
        }));
      } catch {
        return [];
      }
    });

    const allLogArrays = await Promise.all(logPromises);
    let allLogs = allLogArrays.flat();

    // Sort by timestamp descending
    allLogs.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = new Date(a.timestamp as string || 0).getTime();
      const dateB = new Date(b.timestamp as string || 0).getTime();
      return dateB - dateA;
    });

    // Client-side search filter (backend search is per-tenant)
    if (search) {
      const searchLower = search.toLowerCase();
      allLogs = allLogs.filter((log: Record<string, unknown>) =>
        (log.action as string)?.toLowerCase().includes(searchLower) ||
        (log.actor as string)?.toLowerCase().includes(searchLower) ||
        (log.resource_type as string)?.toLowerCase().includes(searchLower) ||
        (log.tenant_name as string)?.toLowerCase().includes(searchLower)
      );
    }

    // Paginate
    const start = (page - 1) * limit;
    const paginatedLogs = allLogs.slice(start, start + limit);

    return NextResponse.json(paginatedLogs);
  } catch (error) {
    console.error('[Audit Logs API] Error:', error);
    return apiError('Failed to fetch audit logs');
  }
}
