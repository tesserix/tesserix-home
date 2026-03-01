import { adminFetch, proxyResponse, apiError } from '@/lib/api/admin-fetch';

export async function GET() {
  try {
    const response = await adminFetch('subscription', '/api/v1/admin/stats/enhanced');
    return proxyResponse(response);
  } catch (error) {
    console.error('Error fetching enhanced stats:', error);
    return apiError('Failed to fetch enhanced stats');
  }
}
