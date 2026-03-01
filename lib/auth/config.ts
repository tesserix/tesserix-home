/**
 * Authentication Configuration for Tesserix Home
 * BFF-based authentication using Keycloak OIDC
 */

const ENVIRONMENT = process.env.NODE_ENV || 'development';

interface AuthConfig {
  bffBaseUrl: string;
  bffInternalUrl: string;
  loginUrl: string;
  logoutUrl: string;
  callbackUrl: string;
  sessionUrl: string;
  refreshUrl: string;
  csrfUrl: string;
  sessionCheckInterval: number;
  sessionRefreshThreshold: number;
}

const configs: Record<string, AuthConfig> = {
  development: {
    bffBaseUrl: 'http://localhost:8080',
    bffInternalUrl: 'http://localhost:8080',
    loginUrl: '/auth/login',
    logoutUrl: '/auth/logout',
    callbackUrl: '/auth/callback',
    sessionUrl: '/auth/session',
    refreshUrl: '/auth/refresh',
    csrfUrl: '/auth/csrf',
    sessionCheckInterval: 300000, // 5 minutes
    sessionRefreshThreshold: 300, // 5 minutes before expiry
  },
  staging: {
    bffBaseUrl: '',
    bffInternalUrl: 'http://auth-bff.identity.svc.cluster.local:8080',
    loginUrl: '/auth/login',
    logoutUrl: '/auth/logout',
    callbackUrl: '/auth/callback',
    sessionUrl: '/auth/session',
    refreshUrl: '/auth/refresh',
    csrfUrl: '/auth/csrf',
    sessionCheckInterval: 300000,
    sessionRefreshThreshold: 300,
  },
  production: {
    bffBaseUrl: '',
    bffInternalUrl: 'http://auth-bff.identity.svc.cluster.local:8080',
    loginUrl: '/auth/login',
    logoutUrl: '/auth/logout',
    callbackUrl: '/auth/callback',
    sessionUrl: '/auth/session',
    refreshUrl: '/auth/refresh',
    csrfUrl: '/auth/csrf',
    sessionCheckInterval: 300000,
    sessionRefreshThreshold: 300,
  },
};

export const authConfig: AuthConfig = configs[ENVIRONMENT] || configs.development;

/**
 * Public paths that don't require authentication
 */
export const PUBLIC_PATHS = [
  '/',
  '/about',
  '/contact',
  '/products',
  '/login',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/error',
  '/api/health',
  '/api/contact',
  '/_next',
  '/favicon.ico',
];

/**
 * Admin paths that require authentication
 */
export const ADMIN_PATHS = [
  '/admin',
];

/**
 * Check if a path is public (doesn't require auth)
 */
export function isPublicPath(pathname: string): boolean {
  // Check exact matches first
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }

  // Check prefix matches for dynamic routes
  return PUBLIC_PATHS.some(path => pathname.startsWith(path + '/') || pathname.startsWith(path));
}

/**
 * Check if a path requires admin authentication
 */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some(path => pathname.startsWith(path));
}

export default authConfig;
