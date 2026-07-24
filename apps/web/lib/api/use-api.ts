"use client";

import { useState, useEffect, useCallback, useRef } from "react";

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
 * Map an HTTP response into a friendlier error message.
 * Falls back to the body's error/message field when present, then to a
 * status-specific default. Caller-friendly strings — never include
 * internal request IDs or stack traces.
 */
async function describeFailure(response: Response): Promise<string> {
  let body: { error?: unknown; message?: unknown } = {};
  try {
    body = await response.clone().json();
  } catch {
    // body wasn't JSON; fall back to status defaults
  }
  if (typeof body.error === "string" && body.error.trim().length > 0) return body.error;
  if (typeof body.message === "string" && body.message.trim().length > 0) return body.message;

  switch (response.status) {
    case 400:
      return "The request was rejected. Check the input and try again.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "We couldn't find what you were looking for.";
    case 408:
      return "The request timed out. Try again.";
    case 409:
      return "That conflicts with the current state. Refresh and try again.";
    case 422:
      return "Some of the input was invalid. Please review and try again.";
    case 429: {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
      if (Number.isFinite(seconds) && seconds > 0) {
        return `You're going too fast. Try again in ${seconds}s.`;
      }
      return "You're going too fast. Try again in a moment.";
    }
    case 500:
    case 502:
    case 503:
    case 504:
      return "Something went wrong on our end. Try again, or contact support if it keeps happening.";
    default:
      return `Request failed (${response.status}).`;
  }
}

function describeNetworkError(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "Request cancelled";
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection.";
  if (err instanceof Error && err.message) return err.message;
  return "An unexpected error occurred.";
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?returnTo=${returnTo}`;
}

/**
 * Generic data-fetching hook for admin API endpoints.
 * Auto-fetches on mount and when the URL changes.
 * Cancels in-flight requests on unmount or URL change.
 */
export function useApi<T>(url: string | null, options: UseApiOptions = {}): UseApiReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!options.skip && !!url);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (!url || options.skip) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
      });

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (!response.ok) {
        setError(await describeFailure(response));
        return;
      }

      const json = await response.json();
      setData(json);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(describeNetworkError(err));
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
 * One-shot mutating call (POST, PUT, DELETE).
 * Returns `{ data }` on success or `{ error }` on failure — never throws.
 */
export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<{ data?: T; error?: string }> {
  try {
    const response = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });

    if (response.status === 401) {
      redirectToLogin();
      return { error: "Your session expired. Redirecting to sign in." };
    }

    if (!response.ok) {
      return { error: await describeFailure(response) };
    }

    // 204 No Content has an empty body
    if (response.status === 204) return { data: undefined as unknown as T };

    const json = (await response.json().catch(() => ({}))) as T;
    return { data: json };
  } catch (err) {
    return { error: describeNetworkError(err) };
  }
}
