import { NOT_IMPLEMENTED, type SurfaceError } from "@/components/kit/surface-state";

/**
 * The CRM read surfaces' one mapping from a caught rejection to something an
 * operator may see.
 *
 * `toSurfaceError` passes `.message` through verbatim — correct for its other
 * callers, which surface errors from `platform-api` whose messages are
 * authored for operators. The CRM pages are not those callers: they catch
 * rejections straight off `pg`, so `relation "crm_opportunities" does not
 * exist`, a constraint name, or a connection string fragment would render
 * into the page. The CRM WRITE path already treats that as a defect — see
 * `lib/crm-write.ts`, whose module comment records that a hand-rolled copy of
 * it leaked a constraint name the first time an everyday collision happened.
 * This is the same control for the read half.
 *
 * Two things are deliberately preserved rather than flattened:
 *
 * - `status`, when the rejection carries one. `resolveState` reads it to
 *   tell the parked-data-plane case (501) apart from a real failure, and
 *   discarding it here would make a parked surface read as broken.
 * - The real error, logged server-side. An operator-safe message is not a
 *   reason to lose the detail an engineer needs; it is a reason not to put
 *   that detail in front of the wrong reader.
 *
 * `toSurfaceError` itself is left alone on purpose — it has callers outside
 * the CRM whose messages are already safe, and narrowing it for all of them
 * would be a change nobody asked for made in the name of this one.
 */
export function crmReadError(caught: unknown, surface: string): SurfaceError | null {
  if (caught === null || caught === undefined) {
    return null;
  }

  const status =
    typeof caught === "object" && typeof (caught as { status?: unknown }).status === "number"
      ? ((caught as { status: number }).status)
      : undefined;

  // Server-side only: this runs in a React Server Component, so it lands in
  // the app's logs, never in the response.
  console.error(`[crm] failed to load ${surface}`, caught);

  if (status === NOT_IMPLEMENTED) {
    // Left for `resolveState` to turn into the instrumentation-unavailable
    // state, which has its own copy; a message here would be ignored.
    return { status };
  }

  return { status, message: `Could not load ${surface}. Try again shortly.` };
}
