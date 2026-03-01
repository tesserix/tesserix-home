import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await adminFetch('subscription', '/api/v1/subscriptions/checkout', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Subscription Checkout API] Error:', error);
    return apiError('Failed to create checkout session');
  }
}
