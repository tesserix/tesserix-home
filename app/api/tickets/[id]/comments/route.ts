import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError } from '@/lib/api/admin-fetch';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (!body.content) {
      return apiError('Content is required', 400);
    }

    const tenantId = body.tenantId || undefined;

    const response = await adminFetch('tickets', `/tickets/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        content: body.content,
        isInternal: body.isInternal || false,
      }),
      tenantId,
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    const resBody = await response.json();
    // Go returns { success, data: {...} } — unwrap
    const comment = resBody?.data || resBody;
    return NextResponse.json(comment, { status: response.status });
  } catch (error) {
    console.error('[Ticket Comments API] Error:', error);
    return apiError('Failed to add comment');
  }
}
