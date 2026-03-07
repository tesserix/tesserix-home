import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const STATUS_SERVICE_URL =
  process.env.STATUS_SERVICE_URL || 'http://localhost:8097/api/v1';

/**
 * GET /api/system-health
 *
 * Single endpoint that fetches the full status from the status-service.
 * The status-service has no auth middleware — it's an internal monitoring
 * service. We just verify the caller has a valid session cookie (authenticated admin).
 */
export async function GET() {
  try {
    // Verify user is authenticated
    const cookieStore = await cookies();
    const session = cookieStore.get('bff_home_session');
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Call status-service directly (no JWT exchange needed)
    const response = await fetch(`${STATUS_SERVICE_URL}/status`, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 0 },
    });

    if (!response.ok) {
      console.error(
        '[System Health API] Backend returned',
        response.status,
        response.statusText
      );
      return NextResponse.json(
        { error: `Status service returned ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[System Health API] Error:', error);
    return NextResponse.json(
      { error: 'Status service unreachable' },
      { status: 503 }
    );
  }
}
