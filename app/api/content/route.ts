import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError } from '@/lib/api/admin-fetch';

/**
 * GET /api/content?tenantId=xxx
 *
 * Fetches content pages for a specific tenant from the settings-service.
 * Content pages are stored as part of the storefront theme settings (JSONB).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenantId');

    if (!tenantId) {
      return apiError('tenantId is required', 400);
    }

    const response = await adminFetch('settings', `/storefront-theme/${tenantId}`, {
      tenantId,
    });

    if (!response.ok) {
      if (response.status === 404) {
        // No settings yet — return empty content pages
        return NextResponse.json({ data: [], tenantId });
      }
      return apiError('Failed to fetch content pages', response.status);
    }

    const settings = await response.json();
    const contentPages = settings?.data?.ecommerce?.contentPages || settings?.data?.contentPages || [];

    return NextResponse.json({ data: contentPages, tenantId });
  } catch (error) {
    console.error('[Content API] GET error:', error);
    return apiError('Failed to fetch content pages');
  }
}

/**
 * PATCH /api/content
 *
 * Updates content pages for a tenant. Only sends contentPages field —
 * the settings-service PATCH merges fields, so theme/style settings are preserved.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { tenantId, contentPages } = body;

    if (!tenantId) {
      return apiError('tenantId is required', 400);
    }

    if (!Array.isArray(contentPages)) {
      return apiError('contentPages must be an array', 400);
    }

    const response = await adminFetch('settings', `/storefront-theme/${tenantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ecommerce: { contentPages } }),
      tenantId,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return apiError(errorData.error || 'Failed to update content pages', response.status);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[Content API] PATCH error:', error);
    return apiError('Failed to update content pages');
  }
}
