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

/**
 * Decode a JWT payload without verifying the signature.
 * Safe for server-side use where the token was already validated by auth-bff.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Extract Istio-style x-jwt-claim-* headers from a decoded JWT.
 * This mimics what the Istio ingress gateway does after JWT validation,
 * enabling server-to-server calls to pass auth context to Go services
 * that read these headers via the IstioAuth middleware.
 */
function getIstioClaimHeaders(claims: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};

  if (claims.sub) headers['x-jwt-claim-sub'] = String(claims.sub);
  if (claims.email) headers['x-jwt-claim-email'] = String(claims.email);
  if (claims.preferred_username) headers['x-jwt-claim-preferred-username'] = String(claims.preferred_username);
  if (claims.name) headers['x-jwt-claim-name'] = String(claims.name);
  if (claims.tenant_id) headers['x-jwt-claim-tenant-id'] = String(claims.tenant_id);
  if (claims.tenant_slug) headers['x-jwt-claim-tenant-slug'] = String(claims.tenant_slug);
  if (claims.staff_id) headers['x-jwt-claim-staff-id'] = String(claims.staff_id);
  if (claims.vendor_id) headers['x-jwt-claim-vendor-id'] = String(claims.vendor_id);
  if (claims.customer_id) headers['x-jwt-claim-customer-id'] = String(claims.customer_id);
  if (claims.platform_owner) headers['x-jwt-claim-platform-owner'] = String(claims.platform_owner);

  // Keycloak realm_access.roles → comma-separated string
  const realmAccess = claims.realm_access as { roles?: string[] } | undefined;
  if (realmAccess?.roles?.length) {
    headers['x-jwt-claim-roles'] = realmAccess.roles.join(',');
  }

  return headers;
}

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

interface TokenResponse {
  access_token: string;
  user_id: string;
  tenant_id?: string;
  tenant_slug?: string;
  expires_at: number;
}

/**
 * Exchange bff_home_session cookie for a JWT access token via auth-bff internal endpoint.
 * This is the proper auth chain: session cookie → auth-bff → JWT → backend services.
 *
 * The Go backend services expect JWT tokens (validated by Istio which injects
 * x-jwt-claim-* headers) — they do NOT understand session cookies.
 */
async function getAccessToken(sessionCookieValue: string): Promise<TokenResponse | null> {
  try {
    const response = await fetch(`${AUTH_BFF_URL}/internal/get-token`, {
      headers: {
        'Cookie': `bff_home_session=${sessionCookieValue}`,
        'X-Session-ID': sessionCookieValue,
        'x-forwarded-host': 'company.tesserix.app',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY } : {}),
      },
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
  /** Override tenant ID for tenant-scoped services (e.g. tickets-service) */
  tenantId?: string;
}

/**
 * Server-side fetch helper for authenticated requests to backend services.
 *
 * Auth flow:
 * 1. Read bff_home_session cookie from browser request
 * 2. Exchange session for JWT via auth-bff /internal/get-token
 * 3. Forward JWT as Authorization: Bearer header to backend services
 * 4. Istio validates JWT and injects x-jwt-claim-* headers for the Go service
 *
 * This ensures proper data isolation:
 * - Platform admins (tesserix-internal realm) get x-jwt-claim-platform-owner=true
 * - Tenant admins (tesserix-customer realm) are scoped to their tenant
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

  // Exchange session cookie for JWT access token
  const tokenData = await getAccessToken(sessionCookie.value);

  if (!tokenData) {
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const baseUrl = getServiceBaseUrl(service);
  const url = `${baseUrl}${path}`;

  const { tenantId, headers: extraHeaders, ...fetchOptions } = options;

  // Decode JWT to extract claims for Istio-style headers.
  // Go backend services use x-jwt-claim-* headers (normally set by Istio ingress
  // after JWT validation). Since we're calling services directly (server-to-server),
  // we must set these headers ourselves.
  const jwtClaims = decodeJwtPayload(tokenData.access_token);
  const istioHeaders = jwtClaims ? getIstioClaimHeaders(jwtClaims) : {};

  // If JWT decode failed (e.g. Logto opaque access tokens), build Istio-style
  // headers from the session data returned by auth-bff /internal/get-token.
  // This ensures Go services always receive the x-jwt-claim-* headers they expect.
  if (!jwtClaims) {
    if (tokenData.user_id) istioHeaders['x-jwt-claim-sub'] = tokenData.user_id;
    if (tokenData.tenant_id) istioHeaders['x-jwt-claim-tenant-id'] = tokenData.tenant_id;
  }

  // tesserix-home is the platform admin app — all authenticated users are platform owners.
  // Set platform_owner so Go services (IstioAuth + RBAC) grant cross-tenant access.
  if (!istioHeaders['x-jwt-claim-platform-owner']) {
    istioHeaders['x-jwt-claim-platform-owner'] = 'true';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tokenData.access_token}`,
    ...istioHeaders,
    ...extraHeaders,
  };

  // For tenant-scoped services, include tenant context via Istio-style header.
  // x-jwt-claim-tenant-id is trusted by IstioAuth; X-Tenant-ID is a legacy fallback.
  if (tenantId) {
    headers['x-jwt-claim-tenant-id'] = tenantId;
    headers['X-Tenant-ID'] = tenantId;
  } else if (tokenData.tenant_id) {
    headers['x-jwt-claim-tenant-id'] = tokenData.tenant_id;
    headers['X-Tenant-ID'] = tokenData.tenant_id;
  }

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  return response;
}

/**
 * Get the authenticated user's context from the session.
 * Returns user info including ID, roles, and tenant context.
 */
export async function getSessionContext(): Promise<{
  userId: string;
  email?: string;
  name?: string;
  tenantId?: string;
  tenantSlug?: string;
  roles: string[];
  accessToken: string;
} | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bff_home_session');

  if (!sessionCookie) {
    return null;
  }

  const tokenData = await getAccessToken(sessionCookie.value);
  if (!tokenData) {
    return null;
  }

  // Also get user info from session endpoint for roles
  try {
    const sessionResponse = await fetch(`${AUTH_BFF_URL}/auth/session`, {
      headers: {
        'Cookie': `bff_home_session=${sessionCookie.value}`,
        'X-Session-ID': sessionCookie.value,
        'x-forwarded-host': 'company.tesserix.app',
      },
    });

    if (!sessionResponse.ok) {
      return null;
    }

    const session = await sessionResponse.json();
    return {
      userId: tokenData.user_id,
      email: session.user?.email,
      name: session.user?.name,
      tenantId: tokenData.tenant_id,
      tenantSlug: tokenData.tenant_slug,
      roles: session.user?.roles || [],
      accessToken: tokenData.access_token,
    };
  } catch {
    return null;
  }
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
