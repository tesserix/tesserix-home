import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const STATUS_DASHBOARD_URL =
  process.env.STATUS_DASHBOARD_SERVICE_URL || 'http://localhost:8097/api/v1';

/** @deprecated Use GET /api/system-health instead */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get('bff_home_session')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const response = await fetch(`${STATUS_DASHBOARD_URL}/services/${id}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      return NextResponse.json({ error: 'Status service error' }, { status: 502 });
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Status service unreachable' }, { status: 503 });
  }
}
