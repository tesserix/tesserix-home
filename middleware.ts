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
