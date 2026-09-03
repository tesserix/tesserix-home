import Link from "next/link";
import { ConsolePageHeader } from "@/components/kit/page-header";

/**
 * The unknown-product state for every `[product]` surface.
 *
 * `not-found.tsx` serves `notFound()` raised in its own segment AND in the
 * segments nested under it, so this file serves both `[product]/page.tsx` and
 * `[product]/[entity]/page.tsx`. The nested half was an expectation when this
 * file was written; it has since been measured, on Next 16.2.11, with a
 * matched pair of production builds of a THROWAWAY MINIMAL APP that reproduced
 * this segment shape — not the console itself, whose layout gate needs a
 * session and a live capability store. With a `[product]/not-found.tsx`
 * present, a refusal from the nested `[product]/[entity]` page rendered it;
 * with that one file removed and nothing else changed, the same refusal fell
 * through to the root `not-found`.
 *
 * So the claim is about Next's boundary resolution for this segment shape at
 * this version, which the console shares, and not an observation of the
 * console serving a request. Nothing sits between `[product]` and
 * `[product]/[entity]` here that the probe lacked, but a future layout or
 * parallel route between them is a reason to re-measure rather than to trust
 * this note.
 *
 * So the copy names no metric, no entity type and no specific page: it has to
 * stay true of every surface on this segment.
 *
 * # It does not name the product, and it does not list the ones that exist
 *
 * The segment an operator typed is deliberately not echoed back. The console
 * refuses a restricted surface with `notFound()` as well — `layout.tsx`'s gate
 * says "not-found, never forbidden", so a page they may not see is
 * indistinguishable from one that was never built. Repeating the segment here
 * would not leak anything by itself, but naming which products DO exist would
 * turn this page into the estate directory the gate is trying not to publish.
 *
 * The rail already shows an operator every product they can reach, so there is
 * somewhere concrete to go without this page enumerating anything.
 */
export default function ProductNotFound() {
  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="No such page"
        description="Nothing in the console is served at this address."
      />

      <p className="max-w-prose text-sm text-muted-foreground">
        The address may be mistyped, or the surface may not exist. The rail on
        the left lists everything you can reach.{" "}
        <Link href="/" className="underline underline-offset-4">
          Go to the estate map
        </Link>
        .
      </p>
    </div>
  );
}
