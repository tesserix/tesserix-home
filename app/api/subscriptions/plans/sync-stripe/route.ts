import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function POST() {
  try {
    const response = await adminFetch('subscription', '/api/v1/plans/sync-stripe', {
      method: 'POST',
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Subscription Stripe Sync API] Error:', error);
    return apiError('Failed to sync plans to Stripe');
  }
}
