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
import { Inbox, LogIn, PlugZap, SearchX } from "lucide-react";
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
  /**
   * Where to send the operator back to after re-authenticating. Only the page
   * rendering this state knows its own path, so it must supply it — this
   * component has no way to discover it on its own.
   */
  reauthReturnTo?: string;
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
  reauthReturnTo,
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
          {/* Callout is a bare padded div — unlike shadcn's Alert it has no
              grid or `[&>svg]` slot, so an icon dropped in as a sibling of
              CalloutTitle (an h5) lands on its own line above the heading.
              The row lives here rather than in the design system because the
              icon is this surface's choice, not the Callout's. */}
          <div className="flex items-start gap-2">
            <PlugZap className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {/* min-w-0 lets the description wrap instead of forcing the flex
                item to its content width and overflowing the card. */}
            <div className="min-w-0">
              {/* The state may carry its own copy — an un-migrated database is
                  the same calm "not wired up yet" state as a parked data plane,
                  but its remedy is running migrations, not reading the park
                  doc. */}
              <CalloutTitle>{state.title ?? "Instrumentation unavailable"}</CalloutTitle>
              <CalloutDescription>
                {state.message ?? INSTRUMENTATION_UNAVAILABLE_MESSAGE}
              </CalloutDescription>
            </div>
          </div>
        </Callout>
      );

    case "reauth-required":
      // A Callout, like instrumentation-unavailable and for the same reason:
      // this is not a failure. Nothing is broken and a retry cannot help — the
      // session is valid but holds no credential for the platform API, and only
      // a fresh sign-in mints one. An ErrorState would offer a retry button
      // that does nothing, which is worse than the generic message this
      // replaces.
      return (
        <Callout variant="warning" role="status">
          <div className="flex items-start gap-2">
            <LogIn className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              {/* "this" would be a dangling reference: this component renders
                  above every surface and knows the name of none of them. */}
              <CalloutTitle>Sign in again to continue</CalloutTitle>
              <CalloutDescription>
                {/* No token vocabulary, no ADR number: the operator cannot act
                    on either, and naming them is what made the old message
                    useless. */}
                This session can no longer reach the platform. Signing in again
                restores it — nothing is lost.{" "}
                {/* A plain anchor, matching "Sign out" in
                    `components/nav/operator-menu.tsx`, and NOT `next/link`.
                    `/auth/login` is a route handler, not a page: it mints
                    `cx_oauth_state` and `cx_oidc_nonce` and redirects to
                    Zitadel. `<Link>` prefetches on viewport entry in
                    production, which EXECUTES that handler — writing a fresh
                    state/nonce pair over the operator's and firing an authorize
                    request nobody asked for, on a callout that renders without
                    anyone clicking anything. */}
                <a
                  href={
                    reauthReturnTo
                      ? `/auth/login?returnTo=${encodeURIComponent(reauthReturnTo)}`
                      : "/auth/login"
                  }
                  className="underline underline-offset-4"
                >
                  Sign in again
                </a>
              </CalloutDescription>
            </div>
          </div>
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
