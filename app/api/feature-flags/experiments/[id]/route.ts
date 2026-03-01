import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await adminFetch('feature-flags', `/experiments/${id}`);

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }
    if (response.status === 404) {
      return apiError('Experiment not found', 404);
    }

    return proxyResponse(response);
  } catch (error) {
    console.error('[Feature Flags Experiment Detail API] Error:', error);
    return apiError('Failed to fetch experiment');
  }
}
