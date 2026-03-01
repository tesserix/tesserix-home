import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await adminFetch('subscription', '/api/v1/admin/settings/stripe/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Stripe Settings API] Verify error:', error);
    return apiError('Failed to verify Stripe key');
  }
}
