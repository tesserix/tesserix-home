import Link from "next/link";
import { ConsolePageHeader } from "@/components/kit/page-header";

/**
 * The unknown-product state for every `[product]` surface.
 *
 * Per Next's documented boundary resolution, `not-found.tsx` serves
 * `notFound()` raised in its own segment and in the segments nested under it —
 * so this file is written to serve `[product]/page.tsx` and, once Task 5 lands
 * it, `[product]/[entity]/page.tsx`. Nothing in this repo exercises that
 * nesting yet, so the second half is an expectation about Next rather than
 * something observed here. Either way the copy names no metric, no entity type
 * and no specific page: it has to stay true of every surface on this segment.
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
