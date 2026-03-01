'use client';

/**
 * Authentication Context and Provider for Tesserix Home
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  getSession,
  refreshSession,
  login as authLogin,
  logout as authLogout,
  logoutAsync,
  isSessionExpiring,
  type SessionUser,
  type SessionResponse,
} from './auth-client';
import { authConfig } from './config';
import { logger } from '../logger';

// Dev auth bypass
const DEV_AUTH_BYPASS = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === 'true';

// Mock session for dev mode
const DEV_MOCK_SESSION: SessionResponse = {
  authenticated: true,
  user: {
    id: 'dev-admin-001',
    email: 'admin@tesserix.local',
    firstName: 'Dev',
    lastName: 'Admin',
    displayName: 'Dev Admin',
    roles: ['admin', 'platform-admin'],
  },
  csrfToken: 'dev-csrf-token',
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
};

interface AuthContextState {
  user: SessionUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  csrfToken: string | null;
  login: (options?: { returnTo?: string; prompt?: 'login' | 'none' }) => void;
  logout: (options?: { returnTo?: string }) => void;
  logoutAsync: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextState | undefined>(undefined);

interface AuthProviderProps {
  children: React.ReactNode;
  initialSession?: SessionResponse | null;
}

export function AuthProvider({ children, initialSession }: AuthProviderProps) {
  const effectiveInitialSession = DEV_AUTH_BYPASS ? DEV_MOCK_SESSION : initialSession;

  const [user, setUser] = useState<SessionUser | null>(effectiveInitialSession?.user || null);
  const [isAuthenticated, setIsAuthenticated] = useState(effectiveInitialSession?.authenticated || false);
  const [isLoading, setIsLoading] = useState(!effectiveInitialSession);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(effectiveInitialSession?.csrfToken || null);
  const [expiresAt, setExpiresAt] = useState<number | null>(effectiveInitialSession?.expiresAt || null);

  const lastSessionCheckRef = useRef<number>(Date.now());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRefreshingRef = useRef<boolean>(false);
  const consecutiveFailuresRef = useRef<number>(0);
  const isOnlineRef = useRef<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  const MIN_CHECK_INTERVAL_MS = 60000; // 1 minute
  const MAX_CONSECUTIVE_FAILURES = 5;
  const MAX_BACKOFF_MS = 300000; // 5 minutes

  useEffect(() => {
    if (DEV_AUTH_BYPASS) {
      logger.debug('[Auth] DEV AUTH BYPASS ENABLED - Using mock session');
    }
  }, []);

  const checkSession = useCallback(async () => {
    if (DEV_AUTH_BYPASS) {
      return DEV_MOCK_SESSION;
    }

    if (isRefreshingRef.current) {
      return null;
    }

    if (!isOnlineRef.current) {
      return null;
    }

    try {
      lastSessionCheckRef.current = Date.now();
      const session = await getSession();

      setIsAuthenticated(session.authenticated);
      setUser(session.user || null);
      setCsrfToken(session.csrfToken || null);
      setExpiresAt(session.expiresAt || null);
      setError(session.error || null);

      consecutiveFailuresRef.current = 0;

      return session;
    } catch (err) {
      logger.error('[Auth] Session check failed:', err);
      consecutiveFailuresRef.current++;
      setIsAuthenticated(false);
      setUser(null);
      setError(err instanceof Error ? err.message : 'Session check failed');
      return null;
    }
  }, []);

  const handleRefresh = useCallback(async (): Promise<boolean> => {
    if (DEV_AUTH_BYPASS) {
      return true;
    }

    if (isRefreshingRef.current) {
      return false;
    }

    if (!isOnlineRef.current) {
      return false;
    }

    isRefreshingRef.current = true;

    try {
      const success = await refreshSession();

      if (success) {
        await checkSession();
        consecutiveFailuresRef.current = 0;
      }

      return success;
    } catch {
      consecutiveFailuresRef.current++;
      return false;
    } finally {
      isRefreshingRef.current = false;
    }
  }, [checkSession]);

  const scheduleSmartRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (!isAuthenticated || !expiresAt) {
      return;
    }

    const expiresAtMs = expiresAt * 1000;
    const now = Date.now();
    const timeUntilExpiry = expiresAtMs - now;
    const refreshThresholdMs = authConfig.sessionRefreshThreshold * 1000;

    let timeUntilRefresh = timeUntilExpiry - refreshThresholdMs;

    if (consecutiveFailuresRef.current > 0) {
      const backoffMs = Math.min(
        1000 * Math.pow(2, consecutiveFailuresRef.current),
        MAX_BACKOFF_MS
      );
      timeUntilRefresh = Math.max(timeUntilRefresh, backoffMs);
    }

    if (timeUntilRefresh <= 0) {
      handleRefresh().then(success => {
        if (!success) {
          setIsAuthenticated(false);
          setUser(null);
        }
      });
      return;
    }

    const maxScheduleTime = authConfig.sessionCheckInterval;
    const scheduledTime = Math.min(timeUntilRefresh, maxScheduleTime);

    refreshTimerRef.current = setTimeout(async () => {
      if (expiresAt && isSessionExpiring(expiresAt, authConfig.sessionRefreshThreshold)) {
        const success = await handleRefresh();
        if (!success && consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          logger.error('[Auth] Max refresh failures reached, logging out');
          setIsAuthenticated(false);
          setUser(null);
          return;
        }
      }
      scheduleSmartRefresh();
    }, scheduledTime);
  }, [isAuthenticated, expiresAt, handleRefresh]);

  // Network status
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      isOnlineRef.current = true;
      if (isAuthenticated) {
        scheduleSmartRefresh();
      }
    };

    const handleOffline = () => {
      isOnlineRef.current = false;
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isAuthenticated, scheduleSmartRefresh]);

  // Initial session check
  useEffect(() => {
    if (DEV_AUTH_BYPASS) {
      return;
    }
    if (!initialSession) {
      setIsLoading(true);
      checkSession().finally(() => setIsLoading(false));
    }
  }, [initialSession, checkSession]);

  // Smart refresh scheduling
  useEffect(() => {
    if (!isAuthenticated) {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      return;
    }

    scheduleSmartRefresh();

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [isAuthenticated, expiresAt, scheduleSmartRefresh]);

  // Visibility change
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isAuthenticated) {
        const now = Date.now();
        const timeSinceLastCheck = now - lastSessionCheckRef.current;

        if (timeSinceLastCheck >= MIN_CHECK_INTERVAL_MS) {
          if (isOnlineRef.current) {
            checkSession();
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isAuthenticated, checkSession]);

  const login = useCallback((options?: { returnTo?: string; prompt?: 'login' | 'none' }) => {
    authLogin(options);
  }, []);

  const logout = useCallback((options?: { returnTo?: string }) => {
    authLogout(options);
  }, []);

  const handleLogoutAsync = useCallback(async () => {
    await logoutAsync();
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value = useMemo<AuthContextState>(() => ({
    user,
    isAuthenticated,
    isLoading,
    error,
    csrfToken,
    login,
    logout,
    logoutAsync: handleLogoutAsync,
    refreshSession: handleRefresh,
    clearError,
  }), [
    user,
    isAuthenticated,
    isLoading,
    error,
    csrfToken,
    login,
    logout,
    handleLogoutAsync,
    handleRefresh,
    clearError,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextState {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useUser(): SessionUser | null {
  const { user } = useAuth();
  return user;
}

export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useAuth();
  return isAuthenticated;
}

export function useCsrfToken(): string | null {
  const { csrfToken } = useAuth();
  return csrfToken;
}

export function useHasRole(role: string | string[]): boolean {
  const { user } = useAuth();

  if (!user) {
    return false;
  }

  const roles = Array.isArray(role) ? role : [role];
  return roles.some(r => user.roles.includes(r));
}

export default AuthProvider;
