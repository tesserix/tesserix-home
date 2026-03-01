import { NextRequest } from 'next/server';
import { adminFetch, proxyResponse, apiError } from '@/lib/api/admin-fetch';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const params = new URLSearchParams();
    const status = searchParams.get('status');
    const limit = searchParams.get('limit');
    const offset = searchParams.get('offset');
    if (status) params.set('status', status);
    if (limit) params.set('limit', limit);
    if (offset) params.set('offset', offset);
    const qs = params.toString();
    const response = await adminFetch('subscription', `/api/v1/admin/invoices${qs ? `?${qs}` : ''}`);
    return proxyResponse(response);
  } catch (error) {
    console.error('Error fetching admin invoices:', error);
    return apiError('Failed to fetch admin invoices');
  }
}
