/**
 * The pure half of the surface-state kit: the state union, the 501 contract,
 * and the function that decides which state a surface is in.
 *
 * Deliberately a separate module from `states.tsx`, and deliberately WITHOUT a
 * `"use client"` directive. `states.tsx` must declare one — it imports
 * `@tesserix/web`, whose barrel is itself a client module — but that directive
 * turns every one of its exports into a client *reference*. Calling one from a
 * React Server Component does not resolve to the function; React throws
 * "Attempted to call resolveState() from the server but it's on the client."
 *
 * The console's data-fetching surfaces are server components, so the decision
 * has to be callable on both sides of the boundary. Nothing in this file may
 * import `@tesserix/web` or React, and `surface-state.test.ts` asserts that.
 *
 * `states.tsx` re-exports everything here, so existing client-side imports of
 * `@/components/kit/states` keep working unchanged.
 */

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
  /**
   * `title`/`message` are optional overrides for the default parked-data-plane
   * copy. They exist because "not wired up yet" has more than one cause and
   * only one of them is the observability park: an un-migrated database is the
   * same calm state with a different remedy, and telling an operator to read
   * the observability doc would send them to the wrong place.
   */
  | { kind: "instrumentation-unavailable"; title?: string; message?: string };

export interface SurfaceError {
  status?: number;
  message?: string;
  /**
   * Copy for the `instrumentation-unavailable` state, when the producer of
   * this error knows something more specific than the default.
   *
   * Opt-in rather than reusing `message`: `message` on a 501 is an internal
   * string in most callers ("console audit log: tesserix database is not
   * configured"), and passing that through to the callout would leak exactly
   * the kind of text this state exists to keep off the page.
   */
  unavailable?: { title?: string; message: string };
}

export interface ResolveStateInput {
  isLoading: boolean;
  error?: SurfaceError | null;
  rows: readonly unknown[];
  /**
   * True when any filter is narrowing the result set. This is the only thing
   * that separates `empty` ("nothing is waiting") from `filtered-empty`
   * ("nothing matches what you asked for") — two situations that want
   * different copy and only one of which has a way out.
   */
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
      const copy = input.error.unavailable;
      return copy
        ? { kind: "instrumentation-unavailable", title: copy.title, message: copy.message }
        : { kind: "instrumentation-unavailable" };
    }
    return { kind: "error", message: input.error.message ?? FALLBACK_ERROR_MESSAGE };
  }
  if (input.rows.length === 0) {
    return { kind: input.filtered ? "filtered-empty" : "empty" };
  }
  return { kind: "ready" };
}

/**
 * Narrows a caught `unknown` to the shape `resolveState` reads.
 *
 * Structural rather than `instanceof PlatformApiError`: this module must stay
 * free of `lib/` imports, a rejection is not guaranteed to be an `Error` at
 * all, and an `instanceof` check across a bundler boundary can quietly fail
 * even when the class is right. Reading `status` and `message` off the value
 * gets the 501 contract right for anything that carries one.
 */
export function toSurfaceError(caught: unknown): SurfaceError | null {
  if (caught === null || caught === undefined) {
    return null;
  }
  if (typeof caught === "object") {
    const candidate = caught as { status?: unknown; message?: unknown };
    return {
      status: typeof candidate.status === "number" ? candidate.status : undefined,
      // An object with no string `message` would otherwise stringify to
      // "[object Object]" in front of an operator.
      message:
        typeof candidate.message === "string" ? candidate.message : FALLBACK_ERROR_MESSAGE,
    };
  }
  return { message: String(caught) };
}
