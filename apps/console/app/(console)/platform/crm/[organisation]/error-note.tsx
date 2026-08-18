"use client";

import { Callout, CalloutDescription } from "@tesserix/web";

/**
 * The one way a failed write speaks to the operator on this surface.
 *
 * Extracted from `organisation-detail-view.tsx` when the activity composer
 * moved to its own file: both need it, and a second copy is how two refusals
 * end up rendered two different ways. `role="alert"` because these appear
 * after an action the operator just took — a message that only a sighted
 * operator notices is not a refusal they have been told about.
 */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout role="alert" variant="destructive" className="mt-2">
      <CalloutDescription>{message}</CalloutDescription>
    </Callout>
  );
}
