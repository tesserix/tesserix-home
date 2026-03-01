import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const body = await request.json();
    const response = await adminFetch('subscription', `/api/v1/subscriptions/${tenantId}/plan`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Subscription Change Plan API] Error:', error);
    return apiError('Failed to change plan');
  }
}
