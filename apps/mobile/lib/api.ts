// api.ts — the app talks ONLY to the tesserix-home mobile gateway with a bearer
// token. The gateway holds the HMAC key and signs to the Go admin API; the app
// never holds that secret and never hits the Go API directly.

import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://home.tesserix.app';
const TOKEN_KEY = 'tx_admin_token';

export const api = axios.create({ baseURL: BASE, timeout: 20000 });

let bearer: string | null = null;

export async function loadToken(): Promise<string | null> {
  bearer = await SecureStore.getItemAsync(TOKEN_KEY);
  return bearer;
}
export async function setToken(token: string | null): Promise<void> {
  bearer = token;
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

api.interceptors.request.use((cfg) => {
  if (bearer) cfg.headers.Authorization = `Bearer ${bearer}`;
  return cfg;
});

/** Turn an axios error into a short, human message for a toast/alert. */
export function apiError(e: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(e)) {
    const d = e.response?.data as { error?: string; message?: string } | undefined;
    return d?.error || d?.message || e.message || fallback;
  }
  return fallback;
}

// HomeChef admin — via the gateway (/api/admin/apps/homechef/gw/<path> → HMAC → Go /api/v1/admin/<path>).
const HC = '/api/admin/apps/homechef/gw';
export const hc = {
  get: <T>(path: string, params?: Record<string, unknown>) =>
    api.get<T>(`${HC}${path}`, { params }).then((r) => r.data),
  post: <T>(path: string, body?: unknown) => api.post<T>(`${HC}${path}`, body).then((r) => r.data),
  put: <T>(path: string, body?: unknown) => api.put<T>(`${HC}${path}`, body).then((r) => r.data),
  del: <T>(path: string) => api.delete<T>(`${HC}${path}`).then((r) => r.data),
};

// Platform admin — tesserix-home's own /api/admin/* routes (tenants, tickets, health…).
export const plat = {
  get: <T>(path: string, params?: Record<string, unknown>) =>
    api.get<T>(`/api/admin${path}`, { params }).then((r) => r.data),
  post: <T>(path: string, body?: unknown) => api.post<T>(`/api/admin${path}`, body).then((r) => r.data),
  put: <T>(path: string, body?: unknown) => api.put<T>(`/api/admin${path}`, body).then((r) => r.data),
};
