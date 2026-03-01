import { NextRequest } from 'next/server';
import { adminFetch, apiError, proxyResponse } from '@/lib/api/admin-fetch';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params;
    const response = await adminFetch('feature-flags', `/features/override/${key}`, {
      method: 'DELETE',
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    return proxyResponse(response);
  } catch (error) {
    console.error('[Feature Flags Clear Override API] Error:', error);
    return apiError('Failed to clear override');
  }
}
