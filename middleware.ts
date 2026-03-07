import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// SECURITY: Production runtime assertion
if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === 'true') {
  throw new Error('SECURITY: DEV_AUTH_BYPASS cannot be enabled in production.');
}

const DEV_AUTH_BYPASS = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === 'true';

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  '/',
  '/about',
  '/contact',
  '/products',
  '/login',
  '/api/health',
  '/api/contact',
];

function isPublicPath(pathname: string): boolean {
  // Check exact matches
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }

  // Check prefix matches
  return PUBLIC_PATHS.some(path =>
    pathname.startsWith(path + '/') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/auth/error') ||
    pathname.startsWith('/api/auth')
  );
}

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith('/admin');
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static files
  if (pathname.match(/\.(ico|png|jpg|jpeg|gif|svg|css|js|woff|woff2|map)$/)) {
    return NextResponse.next();
  }

  // Skip _next paths
  if (pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  // --- CSRF protection for state-mutating API requests ---
  const isApiRoute = pathname.startsWith('/api/');
  const isMutatingMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method);

  if (isApiRoute && isMutatingMethod) {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');

    const allowedHostnames = new Set<string>();
    const host = request.headers.get('host');
    if (host) allowedHostnames.add(host.split(':')[0]);
    const fwdHost = request.headers.get('x-forwarded-host');
    if (fwdHost) allowedHostnames.add(fwdHost.split(',')[0].trim().split(':')[0]);
    const csrfDomains = process.env.CSRF_ALLOWED_DOMAINS;
    if (csrfDomains) {
      csrfDomains.split(',').forEach(d => allowedHostnames.add(d.trim()));
    }

    if (allowedHostnames.size > 0) {
      let originMatch = false;
      if (origin) {
        try { originMatch = allowedHostnames.has(new URL(origin).hostname); } catch { /* */ }
      }
      let refererMatch = false;
      if (referer) {
        try { refererMatch = allowedHostnames.has(new URL(referer).hostname); } catch { /* */ }
      }

      if (origin && !originMatch) {
        return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
      }
      if (!origin && referer && !refererMatch) {
        return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
      }
      if (!origin && !referer && !pathname.startsWith('/api/auth')) {
        return NextResponse.json({ error: 'CSRF check failed: Origin header required' }, { status: 403 });
      }
    }
  }

  // Public paths - no auth required
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // DEV MODE: Skip auth check
  if (DEV_AUTH_BYPASS) {
    return NextResponse.next();
  }

  // Admin paths require authentication
  if (isAdminPath(pathname)) {
    // Check for session cookie (auth-bff sets 'bff_home_session' for tesserix-home)
    const sessionCookie = request.cookies.get('bff_home_session');

    if (!sessionCookie) {
      // Redirect to login page
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('returnTo', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};
