import { NextRequest, NextResponse } from 'next/server';
import { onboardingFetch, isAuthenticated } from '@/lib/api/onboarding-fetch';

/**
 * Catch-all proxy route for onboarding content management.
 *
 * Maps tesserix-home API routes to tenant-onboarding internal endpoints:
 *   GET  /api/onboarding-content/faqs       → GET  /api/internal/content/faqs
 *   POST /api/onboarding-content/faqs       → POST /api/internal/content/faqs
 *   PUT  /api/onboarding-content/faqs/{id}  → PUT  /api/internal/content/faqs/{id}
 *   DELETE /api/onboarding-content/faqs/{id} → DELETE /api/internal/content/faqs/{id}
 *   etc.
 */

async function proxyToOnboarding(request: NextRequest, pathSegments: string[]) {
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const targetPath = '/api/internal/content/' + pathSegments.join('/');

  const options: RequestInit = {
    method: request.method,
  };

  // Forward body for POST/PUT/PATCH
  if (!['GET', 'HEAD'].includes(request.method)) {
    const body = await request.text();
    if (body) {
      options.body = body;
    }
  }

  try {
    const response = await onboardingFetch(targetPath, options);

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Invalid response from onboarding service' }, { status: 502 });
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[Onboarding Proxy] Error:', error);
    return NextResponse.json({ error: 'Onboarding service unavailable' }, { status: 503 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyToOnboarding(request, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyToOnboarding(request, path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyToOnboarding(request, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyToOnboarding(request, path);
}
