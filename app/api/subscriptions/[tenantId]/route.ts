import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const response = await adminFetch('subscription', `/api/v1/subscriptions/${tenantId}`);
    if (response.status === 401) return apiError('Unauthorized', 401);
    if (response.status === 404) return apiError('Subscription not found', 404);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Subscription API] Error:', error);
    return apiError('Failed to fetch subscription');
  }
}
