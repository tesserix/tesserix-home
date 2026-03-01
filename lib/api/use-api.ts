"use client";

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseApiOptions {
  /** Skip the initial fetch (e.g. for conditional fetching) */
  skip?: boolean;
}

interface UseApiReturn<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  mutate: () => Promise<void>;
}

/**
 * Generic data fetching hook for admin API endpoints.
 * Auto-fetches on mount and when the URL changes.
 */
export function useApi<T>(url: string | null, options: UseApiOptions = {}): UseApiReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!options.skip && !!url);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (!url || options.skip) return;

    // Cancel previous request
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(url, {
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || body.message || `Request failed (${response.status})`);
      }

      const json = await response.json();
      setData(json);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  }, [url, options.skip]);

  useEffect(() => {
    fetchData();
    return () => abortControllerRef.current?.abort();
  }, [fetchData]);

  return { data, error, isLoading, mutate: fetchData };
}

/**
 * Helper to make mutating API calls (POST, PUT, DELETE).
 */
export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<{ data?: T; error?: string }> {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    if (response.status === 401) {
      window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
      return { error: 'Unauthorized' };
    }

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { error: json.error || json.message || `Request failed (${response.status})` };
    }

    return { data: json as T };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}
