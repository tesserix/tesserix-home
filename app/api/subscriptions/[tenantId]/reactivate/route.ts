import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const response = await adminFetch('subscription', `/api/v1/subscriptions/${tenantId}/reactivate`, {
      method: 'POST',
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Subscription Reactivate API] Error:', error);
    return apiError('Failed to reactivate subscription');
  }
}
