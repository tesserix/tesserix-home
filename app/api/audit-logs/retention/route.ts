import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, getSessionContext, apiError } from '@/lib/api/admin-fetch';

/**
 * GET /api/audit-logs/retention
 *
 * Fetches retention settings. Since the Go audit service requires a tenant_id,
 * we pick the first tenant as a representative (retention is typically uniform).
 */
export async function GET() {
  try {
    const session = await getSessionContext();
    if (!session) {
      return apiError('Unauthorized', 401);
    }

    // Fetch tenant list to get a valid tenant_id
    const tenantsResponse = await adminFetch('tenant', '/api/v1/users/me/tenants?limit=1');
    if (!tenantsResponse.ok) {
      return apiError('Failed to fetch tenants', tenantsResponse.status);
    }

    const tenantsBody = await tenantsResponse.json();
    const tenantsNested = tenantsBody?.data;
    const tenants = Array.isArray(tenantsNested?.tenants)
      ? tenantsNested.tenants
      : Array.isArray(tenantsNested) ? tenantsNested : [];

    if (tenants.length === 0) {
      // Return sensible defaults when no tenants exist
      return NextResponse.json({
        retention_days: 90,
        auto_cleanup_enabled: false,
      });
    }

    const tid = tenants[0].tenant_id || tenants[0].id || '';
    const response = await adminFetch('audit', '/audit-logs/retention', {
      tenantId: tid,
    });

    if (!response.ok) {
      // Return defaults if the service doesn't have settings yet
      return NextResponse.json({
        retention_days: 90,
        auto_cleanup_enabled: false,
      });
    }

    const data = await response.json();
    return NextResponse.json(data.data || data);
  } catch (error) {
    console.error('[Audit Retention API] Error:', error);
    return apiError('Failed to fetch retention settings');
  }
}

/**
 * PUT /api/audit-logs/retention
 *
 * Updates retention settings across all tenants.
 */
export async function PUT(request: NextRequest) {
  try {
    const session = await getSessionContext();
    if (!session) {
      return apiError('Unauthorized', 401);
    }

    const body = await request.json();

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
      return apiError('No tenants found', 404);
    }

    // Apply retention settings to all tenants in parallel
    const updatePromises = tenants.map(async (tenant: { tenant_id?: string; id?: string }) => {
      const tid = tenant.tenant_id || tenant.id || '';
      try {
        return await adminFetch('audit', '/audit-logs/retention', {
          method: 'PUT',
          body: JSON.stringify(body),
          tenantId: tid,
        });
      } catch {
        return null;
      }
    });

    const results = await Promise.all(updatePromises);
    const anySuccess = results.some((r) => r && r.ok);

    if (!anySuccess) {
      return apiError('Failed to update retention settings for any tenant');
    }

    return NextResponse.json({ success: true, ...body });
  } catch (error) {
    console.error('[Audit Retention API] Error:', error);
    return apiError('Failed to update retention settings');
  }
}
