import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = searchParams.get('page') || '1';
    const limit = searchParams.get('limit') || '20';
    const status = searchParams.get('status');
    const search = searchParams.get('search');

    // Build query string for tenant-service
    const params = new URLSearchParams({ page, limit });
    if (status && status !== 'all') params.set('status', status);
    if (search) params.set('search', search);

    // Platform admin fetches all tenants via membership endpoint
    const response = await adminFetch('tenant', `/api/v1/users/me/tenants?${params}`);

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    // Normalize tenant-service response: { data: { count, tenants: [...] } }
    // into the shape the frontend expects: { data: Tenant[], total, page, pageSize }
    const body = await response.json();
    const nested = body?.data;
    const tenants = Array.isArray(nested?.tenants) ? nested.tenants : [];

    // Map tenant_id → id for frontend consistency
    const normalized = tenants.map((t: Record<string, unknown>) => ({
      id: t.tenant_id,
      name: t.name,
      slug: t.slug,
      subdomain: t.subdomain,
      custom_domain: t.custom_domain,
      use_custom_domain: t.use_custom_domain,
      display_name: t.display_name,
      status: t.status,
      email: t.email,
      plan: t.plan,
      industry: t.industry,
      admin_url: t.admin_url,
      storefront_url: t.storefront_url,
      business_model: t.business_model,
      primary_color: t.primary_color,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    return NextResponse.json({
      data: normalized,
      total: nested?.count ?? normalized.length,
      page: parseInt(page),
      pageSize: parseInt(limit),
    });
  } catch (error) {
    console.error('[Tenants API] Error:', error);
    return apiError('Failed to fetch tenants');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.name) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    const response = await adminFetch('tenant', '/api/v1/tenants/create-for-user', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    return proxyResponse(response);
  } catch (error) {
    console.error('[Tenants API] Error:', error);
    return apiError('Failed to create tenant');
  }
}
