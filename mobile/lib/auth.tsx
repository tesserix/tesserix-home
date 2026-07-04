// auth.tsx — admin session. Two ways in, one shape out:
//  • Google native sign-in → POST /api/auth/mobile/google {idToken} → the gateway
//    validates the id_token + the ALLOWED_ADMIN_EMAILS allowlist and returns a
//    bearer session (prod).
//  • Dev bypass (EXPO_PUBLIC_DEV_AUTH_BYPASS=true) → the gateway mints a mock
//    admin session so the whole app is testable without Google set up (dev only).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, loadToken, setToken } from './api';

export interface AdminUser {
  email: string;
  name: string;
}

interface AuthValue {
  user: AdminUser | null;
  ready: boolean;
  busy: boolean;
  signInWithGoogle: (idToken: string) => Promise<void>;
  signInDev: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);
const DEV_BYPASS = process.env.EXPO_PUBLIC_DEV_AUTH_BYPASS === 'true';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // On boot: restore a saved token and confirm it against the session endpoint.
  useEffect(() => {
    (async () => {
      const token = await loadToken();
      if (token) {
        try {
          const { data } = await api.get<{ email: string; name: string }>('/api/auth/mobile/session');
          setUser({ email: data.email, name: data.name });
        } catch {
          await setToken(null);
        }
      }
      setReady(true);
    })();
  }, []);

  const finish = useCallback(async (token: string, u: AdminUser) => {
    await setToken(token);
    setUser(u);
  }, []);

  const signInWithGoogle = useCallback(
    async (idToken: string) => {
      setBusy(true);
      try {
        const { data } = await api.post<{ token: string; email: string; name: string }>(
          '/api/auth/mobile/google',
          { idToken },
        );
        await finish(data.token, { email: data.email, name: data.name });
      } finally {
        setBusy(false);
      }
    },
    [finish],
  );

  const signInDev = useCallback(async () => {
    setBusy(true);
    try {
      const { data } = await api.post<{ token: string; email: string; name: string }>(
        '/api/auth/mobile/dev',
        {},
      );
      await finish(data.token, { email: data.email, name: data.name });
    } finally {
      setBusy(false);
    }
  }, [finish]);

  const signOut = useCallback(async () => {
    await setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ user, ready, busy, signInWithGoogle, signInDev, signOut }),
    [user, ready, busy, signInWithGoogle, signInDev, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}

export const devBypassEnabled = DEV_BYPASS;
