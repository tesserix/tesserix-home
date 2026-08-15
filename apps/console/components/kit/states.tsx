// See page-header.tsx: @tesserix/web's barrel is "use client", so its exports
// are `undefined` inside a server component. This directive is load-bearing
// even though nothing here uses a hook.
"use client";

import type { ReactNode } from "react";
import {
  Button,
  Callout,
  CalloutDescription,
  CalloutTitle,
  DataTableSkeleton,
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ErrorState,
} from "@tesserix/web";
import { Inbox, PlugZap, SearchX } from "lucide-react";

/**
 * Every console surface is in exactly one of these states. There are five
 * non-ready kinds, not four: `instrumentation-unavailable` is deliberately
 * separate from both `empty` and `error` so a parked data plane never reads
 * as healthy, and a network blip never claims the product is uninstrumented.
 */
export type SurfaceState =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "filtered-empty" }
  | { kind: "error"; message: string }
  | { kind: "instrumentation-unavailable" };

export interface SurfaceError {
  status?: number;
  message?: string;
}

export interface ResolveStateInput {
  isLoading: boolean;
  error?: SurfaceError | null;
  rows: readonly unknown[];
  filtered: boolean;
}

/**
 * 501 Not Implemented is the agreed signal from a service whose observability
 * data plane is parked. Any other failure is a real error. Exported so every
 * surface tests the same number — two private copies is exactly how this
 * invariant drifts apart.
 */
export const NOT_IMPLEMENTED = 501;

const FALLBACK_ERROR_MESSAGE = "Something went wrong loading this surface.";

export const INSTRUMENTATION_UNAVAILABLE_MESSAGE =
  "Instrumentation is unavailable — the observability data plane is parked. See docs/observability-park.md.";

export function resolveState(input: ResolveStateInput): SurfaceState {
  if (input.isLoading) {
    return { kind: "loading" };
  }
  if (input.error) {
    if (input.error.status === NOT_IMPLEMENTED) {
      return { kind: "instrumentation-unavailable" };
    }
    return { kind: "error", message: input.error.message ?? FALLBACK_ERROR_MESSAGE };
  }
  if (input.rows.length === 0) {
    return { kind: input.filtered ? "filtered-empty" : "empty" };
  }
  return { kind: "ready" };
}

export interface SurfaceStateViewProps {
  state: SurfaceState;
  /** Copy for the `empty` state — what this surface holds when it has data. */
  emptyMessage: string;
  onRetry?: () => void;
  onClearFilters?: () => void;
}

/**
 * Renders any non-ready state. Returns `null` for `ready` so callers can
 * render it unconditionally above their own content.
 */
export function SurfaceStateView({
  state,
  emptyMessage,
  onRetry,
  onClearFilters,
}: SurfaceStateViewProps): ReactNode {
  switch (state.kind) {
    case "ready":
      return null;

    case "loading":
      return <DataTableSkeleton aria-busy="true" aria-label="Loading" />;

    case "empty":
      return (
        <EmptyState>
          <EmptyStateIcon>
            <Inbox aria-hidden="true" />
          </EmptyStateIcon>
          <EmptyStateTitle>Nothing here yet</EmptyStateTitle>
          <EmptyStateDescription>{emptyMessage}</EmptyStateDescription>
        </EmptyState>
      );

    case "filtered-empty":
      return (
        <EmptyState>
          <EmptyStateIcon>
            <SearchX aria-hidden="true" />
          </EmptyStateIcon>
          <EmptyStateTitle>No matches</EmptyStateTitle>
          <EmptyStateDescription>
            {onClearFilters
              ? "No rows match the current filters. Clear them to see everything."
              : "No rows match the current filters."}
          </EmptyStateDescription>
          {onClearFilters ? (
            <EmptyStateActions>
              <Button type="button" variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            </EmptyStateActions>
          ) : null}
        </EmptyState>
      );

    case "error":
      return (
        <ErrorState
          type="server_error"
          message={state.message}
          showRetryButton={Boolean(onRetry)}
          onRetry={onRetry}
        />
      );

    case "instrumentation-unavailable":
      // Deliberately neither EmptyState nor ErrorState: a warning Callout so
      // "we are not measuring this" cannot be mistaken for "there is nothing
      // to measure" or "the request failed and a retry might fix it".
      return (
        <Callout variant="warning" role="status">
          <PlugZap className="h-4 w-4" aria-hidden="true" />
          <CalloutTitle>Instrumentation unavailable</CalloutTitle>
          <CalloutDescription>{INSTRUMENTATION_UNAVAILABLE_MESSAGE}</CalloutDescription>
        </Callout>
      );

    default: {
      // Adding a member to SurfaceState without a case here fails the build
      // rather than silently rendering nothing.
      const unhandled = state satisfies never;
      return unhandled;
    }
  }
}
