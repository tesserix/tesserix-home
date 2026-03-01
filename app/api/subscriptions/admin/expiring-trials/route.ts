import { NextRequest } from 'next/server';
import { adminFetch, proxyResponse, apiError } from '@/lib/api/admin-fetch';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = searchParams.get('days') || '30';
    const response = await adminFetch('subscription', `/api/v1/admin/stats/expiring-trials?days=${days}`);
    return proxyResponse(response);
  } catch (error) {
    console.error('Error fetching expiring trials:', error);
    return apiError('Failed to fetch expiring trials');
  }
}
