import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function POST(_request: NextRequest) {
  try {
    const response = await adminFetch('subscription', '/api/v1/admin/settings/stripe/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Stripe Settings API] Reload error:', error);
    return apiError('Failed to reload Stripe keys');
  }
}
