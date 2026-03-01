import { NextRequest, NextResponse } from 'next/server';
import { adminFetch, apiError } from '@/lib/api/admin-fetch';
import { normalizeTicket } from '../../normalize';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (!body.status) {
      return apiError('Status is required', 400);
    }

    const tenantId = body.tenantId || undefined;

    const response = await adminFetch('tickets', `/tickets/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: body.status.toUpperCase() }),
      tenantId,
    });

    if (response.status === 401) {
      return apiError('Unauthorized', 401);
    }

    const resBody = await response.json();
    const ticket = resBody?.data || resBody;
    return NextResponse.json(normalizeTicket(ticket), { status: response.status });
  } catch (error) {
    console.error('[Ticket Status API] Error:', error);
    return apiError('Failed to update ticket status');
  }
}
