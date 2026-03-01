import { NextRequest } from 'next/server';
import { adminFetch, proxyResponse, apiError } from '@/lib/api/admin-fetch';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const body = await request.json();
    const response = await adminFetch('subscription', `/api/v1/admin/subscriptions/${tenantId}/extend-trial`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return proxyResponse(response);
  } catch (error) {
    console.error('Error extending trial:', error);
    return apiError('Failed to extend trial');
  }
}
