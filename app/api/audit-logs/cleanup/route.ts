import { NextResponse } from 'next/server';
import { adminFetch, getSessionContext, apiError } from '@/lib/api/admin-fetch';

/**
 * POST /api/audit-logs/cleanup
 *
 * Triggers audit log cleanup across all tenants.
 */
export async function POST() {
  try {
    const session = await getSessionContext();
    if (!session) {
      return apiError('Unauthorized', 401);
    }

    // Fetch all tenants
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
      return NextResponse.json({ success: true, cleaned: 0 });
    }

    // Trigger cleanup for each tenant in parallel
    const cleanupPromises = tenants.map(async (tenant: { tenant_id?: string; id?: string }) => {
      const tid = tenant.tenant_id || tenant.id || '';
      try {
        const response = await adminFetch('audit', '/audit-logs/cleanup', {
          method: 'POST',
          tenantId: tid,
        });

        if (!response.ok) return null;
        return response.json();
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(cleanupPromises)).filter(Boolean);

    // Aggregate cleanup results
    let totalCleaned = 0;
    for (const r of results) {
      totalCleaned += r.deleted_count || r.cleaned || 0;
    }

    return NextResponse.json({
      success: true,
      tenants_processed: results.length,
      total_cleaned: totalCleaned,
    });
  } catch (error) {
    console.error('[Audit Cleanup API] Error:', error);
    return apiError('Failed to trigger cleanup');
  }
}
