import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function GET() {
  try {
    const response = await adminFetch('subscription', '/api/v1/admin/settings/stripe');
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Stripe Settings API] GET error:', error);
    return apiError('Failed to fetch Stripe settings');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const response = await adminFetch('subscription', '/api/v1/admin/settings/stripe', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (response.status === 401) return apiError('Unauthorized', 401);
    return proxyResponse(response);
  } catch (error) {
    console.error('[Stripe Settings API] PUT error:', error);
    return apiError('Failed to update Stripe keys');
  }
}
