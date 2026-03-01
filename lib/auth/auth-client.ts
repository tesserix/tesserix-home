/**
 * Auth Client for BFF Communication
 */

import { authConfig } from './config';
import { logger } from '../logger';

/**
 * Session user information
 */
export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  avatar?: string;
  roles: string[];
}

/**
 * Session response from BFF
 */
export interface SessionResponse {
  authenticated: boolean;
  user?: SessionUser;
  expiresAt?: number;
  csrfToken?: string;
  error?: string;
}

/**
 * Auth error class
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Get current session from BFF
 */
export async function getSession(): Promise<SessionResponse> {
  try {
    const response = await fetch(authConfig.sessionUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { authenticated: false };
      }
      if (response.status === 429) {
        logger.warn('[Auth] Rate limited - will retry later');
        return { authenticated: false, error: 'rate_limited' };
      }
      throw new AuthError(
        'Failed to get session',
        'session_error',
        response.status
      );
    }

    const data = await response.json();
    return data as SessionResponse;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    logger.error('[Auth] Session check failed:', error);
    return { authenticated: false, error: 'network_error' };
  }
}

/**
 * Get CSRF token for protected operations
 */
export async function getCsrfToken(): Promise<string | null> {
  try {
    const response = await fetch(authConfig.csrfUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.csrfToken || null;
  } catch {
    return null;
  }
}

/**
 * Refresh session tokens
 */
export async function refreshSession(): Promise<boolean> {
  try {
    const csrfToken = await getCsrfToken();

    const response = await fetch(authConfig.refreshUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: JSON.stringify({}),
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Initiate login flow
 */
export function login(options?: {
  returnTo?: string;
  prompt?: 'login' | 'none';
}): void {
  const params = new URLSearchParams();

  if (options?.returnTo) {
    params.set('returnTo', options.returnTo);
  }
  if (options?.prompt) {
    params.set('prompt', options.prompt);
  }

  const queryString = params.toString();
  const loginUrl = queryString
    ? `${authConfig.loginUrl}?${queryString}`
    : authConfig.loginUrl;

  window.location.href = loginUrl;
}

/**
 * Initiate logout flow
 */
export function logout(options?: {
  returnTo?: string;
}): void {
  const params = new URLSearchParams();

  if (options?.returnTo) {
    params.set('returnTo', options.returnTo);
  }

  const queryString = params.toString();
  const logoutUrl = queryString
    ? `${authConfig.logoutUrl}?${queryString}`
    : authConfig.logoutUrl;

  window.location.href = logoutUrl;
}

/**
 * Perform logout via POST
 */
export async function logoutAsync(): Promise<void> {
  const csrfToken = await getCsrfToken();

  const response = await fetch(authConfig.logoutUrl, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
  });

  if (response.redirected) {
    window.location.href = response.url;
  } else {
    window.location.href = '/';
  }
}

/**
 * Check if session is about to expire
 */
export function isSessionExpiring(expiresAt: number, thresholdSeconds: number = 300): boolean {
  const now = Math.floor(Date.now() / 1000);
  return expiresAt - thresholdSeconds <= now;
}

export default {
  getSession,
  getCsrfToken,
  refreshSession,
  isSessionExpiring,
  login,
  logout,
  logoutAsync,
};
