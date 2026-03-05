import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const TENANT_SERVICE_URL = process.env.TENANT_SERVICE_URL || 'http://localhost:8080';
const TICKETS_SERVICE_URL = process.env.TICKETS_SERVICE_URL || 'http://localhost:8081/api/v1';
const AUTH_BFF_URL = process.env.AUTH_BFF_URL || 'http://localhost:8082';
const MARKETPLACE_SETTINGS_SERVICE_URL = process.env.MARKETPLACE_SETTINGS_SERVICE_URL || 'http://localhost:8085/api/v1';
const SUBSCRIPTION_SERVICE_URL = process.env.SUBSCRIPTION_SERVICE_URL || 'http://localhost:8093';
const AUDIT_SERVICE_URL = process.env.AUDIT_SERVICE_URL || 'http://localhost:8080/api/v1';
const FEATURE_FLAGS_SERVICE_URL = process.env.FEATURE_FLAGS_SERVICE_URL || 'http://localhost:8096/api/v1';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:8090/api/v1';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

export type ServiceName = 'tenant' | 'tickets' | 'auth' | 'settings' | 'subscription' | 'audit' | 'feature-flags' | 'notification';

function getServiceBaseUrl(service: ServiceName): string {
  switch (service) {
    case 'tenant':
      return TENANT_SERVICE_URL;
    case 'tickets':
      return TICKETS_SERVICE_URL;
    case 'auth':
      return AUTH_BFF_URL;
    case 'settings':
      return MARKETPLACE_SETTINGS_SERVICE_URL;
    case 'subscription':
      return SUBSCRIPTION_SERVICE_URL;
    case 'audit':
      return AUDIT_SERVICE_URL;
    case 'feature-flags':
      return FEATURE_FLAGS_SERVICE_URL;
    case 'notification':
      return NOTIFICATION_SERVICE_URL;
  }
}

interface SessionExchangeResponse {
  access_token: string;
  id_token: string;
  user_id: string;
  email: string;
  tenant_id?: string;
  tenant_slug?: string;
  auth_context: string;
  expires_at: number;
}

/**
 * Exchange session cookie for tokens via auth-bff internal endpoint.
 * The encrypted cookie is sent to auth-bff which decrypts it and returns the tokens.
 */
async function exchangeSession(cookieName: string, cookieValue: string): Promise<SessionExchangeResponse | null> {
  try {
    const response = await fetch(`${AUTH_BFF_URL}/internal/session-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'Authorization': `Bearer ${INTERNAL_SERVICE_KEY}` } : {}),
      },
      body: JSON.stringify({ cookie_name: cookieName, cookie_value: cookieValue }),
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

interface AdminFetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  tenantId?: string;
}

/**
 * Server-side fetch helper for authenticated requests to backend services.
 *
 * Auth flow (serverless / Cloud Run):
 * 1. Read bff_home_session cookie from browser request
 * 2. Send cookie to auth-bff /internal/session-exchange to decrypt and get tokens
 * 3. Forward access token as Authorization: Bearer header to backend services
 * 4. Backend services verify the token directly (no Istio)
 */
export async function adminFetch(
  service: ServiceName,
  path: string,
  options: AdminFetchOptions = {}
): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bff_home_session');

  if (!sessionCookie) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessionData = await exchangeSession('bff_home_session', sessionCookie.value);

  if (!sessionData) {
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const baseUrl = getServiceBaseUrl(service);
  const url = `${baseUrl}${path}`;

  const { tenantId, headers: extraHeaders, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionData.access_token}`,
    ...extraHeaders,
  };

  // Pass tenant context for tenant-scoped services
  if (tenantId) {
    headers['X-Tenant-ID'] = tenantId;
  } else if (sessionData.tenant_id) {
    headers['X-Tenant-ID'] = sessionData.tenant_id;
  }

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  return response;
}

/**
 * Get the authenticated user's context from the session.
 */
export async function getSessionContext(): Promise<{
  userId: string;
  email?: string;
  tenantId?: string;
  tenantSlug?: string;
  authContext: string;
  accessToken: string;
} | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bff_home_session');

  if (!sessionCookie) {
    return null;
  }

  const sessionData = await exchangeSession('bff_home_session', sessionCookie.value);
  if (!sessionData) {
    return null;
  }

  return {
    userId: sessionData.user_id,
    email: sessionData.email,
    tenantId: sessionData.tenant_id,
    tenantSlug: sessionData.tenant_slug,
    authContext: sessionData.auth_context,
    accessToken: sessionData.access_token,
  };
}

/**
 * Helper to return a JSON error response for API routes.
 */
export function apiError(message: string, status: number = 500): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Helper to proxy a backend response as a NextResponse.
 */
export async function proxyResponse(response: Response): Promise<NextResponse> {
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid response from backend' }, { status: 502 });
  }
  return NextResponse.json(data, { status: response.status });
}
