import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await adminFetch('audit', `/audit-logs/${id}`);

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }
    if (response.status === 404) {
      return apiError('Audit log not found', 404);
    }

    return proxyResponse(response);
  } catch (error) {
    console.error('[Audit Log Detail API] Error:', error);
    return apiError('Failed to fetch audit log');
  }
}
