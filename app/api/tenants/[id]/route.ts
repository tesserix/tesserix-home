import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const response = await adminFetch('tenant', `/internal/tenants/${id}`, {
      headers: { 'X-Internal-Service': 'tesserix-home' },
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }
    if (response.status === 404) {
      return apiError('Tenant not found', 404);
    }

    // Unwrap Go service response: { success, data: TenantBasicInfo, message }
    const body = await response.json();
    const t = body?.data ?? body;

    // Normalize to match the frontend Tenant interface (snake_case)
    const tenant = {
      id: t.id,
      name: t.name,
      slug: t.slug,
      subdomain: t.subdomain,
      custom_domain: t.custom_domain,
      use_custom_domain: t.use_custom_domain,
      display_name: t.displayName || t.display_name,
      email: t.billingEmail || t.billing_email,
      status: t.status,
      plan: t.pricing_tier,
      industry: t.industry,
      business_model: t.business_model,
      primary_color: t.primary_color,
      logo_url: t.logo_url,
      admin_url: t.admin_url,
      storefront_url: t.storefront_url,
      created_at: t.created_at,
      updated_at: t.updated_at,
    };

    return NextResponse.json(tenant);
  } catch (error) {
    console.error('[Tenant Detail API] Error:', error);
    return apiError('Failed to fetch tenant');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const response = await adminFetch('tenant', `/api/v1/tenants/${id}/admin-delete`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    return proxyResponse(response);
  } catch (error) {
    console.error('[Tenant Delete API] Error:', error);
    return apiError('Failed to delete tenant');
  }
}
