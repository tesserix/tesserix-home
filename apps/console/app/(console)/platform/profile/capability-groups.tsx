// Required even though this component holds no state, for the reason
// `components/kit/page-header.tsx` states at its own directive: @tesserix/web's
// barrel is itself "use client", and its exports resolve to `undefined` when
// imported into a SERVER component. React then fails at render with
// "Element type is invalid ... got: undefined", which neither typecheck nor
// `next build` catches — the profile page shipped exactly that way and broke
// in production.
//
// So the page stays a server component and does the data work; every
// @tesserix/web element it needs is rendered from here.
"use client";

import { Badge } from "@tesserix/web";
import type { Capability } from "@tesserix/platform-auth";

export function CapabilityGroup({
  title,
  description,
  all,
  held,
}: {
  title: string;
  description: string;
  all: readonly Capability[];
  held: readonly string[];
}) {
  const heldSet = new Set(held);
  const present = all.filter((c) => heldSet.has(c));
  return (
    <section className="border-t border-border pt-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
      {present.length === 0 ? (
        // Not an empty list: "you hold none of these" is a real answer, and the
        // one a narrowly-granted operator is most likely to be reading for.
        <p className="mt-2 text-[13px] text-muted-foreground">None held.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {present.map((capability) => (
            <li key={capability}>
              <Badge variant="outline" className="font-normal">
                <span>{label(capability)}</span>
                <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                  {capability}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `crm` -> `CRM`, `rotate-credentials` -> `Rotate credentials`. The slug is
 *  still shown, because it is the string a grant is written with in Zitadel
 *  and an operator asking for one needs to quote it exactly. */
function label(capability: Capability): string {
  if (capability === "crm") return "CRM";
  const spaced = capability.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
