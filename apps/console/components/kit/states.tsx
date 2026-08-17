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
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE, type SurfaceState } from "./surface-state";

/**
 * The state union, the 501 contract and `resolveState` live in
 * `./surface-state`, which carries no `"use client"` directive so server
 * components can actually call them — this module's directive would turn them
 * into client references that throw when invoked on the server. They are
 * re-exported here so existing client-side imports of this module are
 * unaffected; server components must import `./surface-state` directly.
 */
export { INSTRUMENTATION_UNAVAILABLE_MESSAGE };
export { NOT_IMPLEMENTED, resolveState, toSurfaceError } from "./surface-state";
export type { ResolveStateInput, SurfaceError, SurfaceState } from "./surface-state";

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
          {/* The state may carry its own copy — an un-migrated database is
              the same calm "not wired up yet" state as a parked data plane,
              but its remedy is running migrations, not reading the park doc. */}
          <CalloutTitle>{state.title ?? "Instrumentation unavailable"}</CalloutTitle>
          <CalloutDescription>
            {state.message ?? INSTRUMENTATION_UNAVAILABLE_MESSAGE}
          </CalloutDescription>
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
