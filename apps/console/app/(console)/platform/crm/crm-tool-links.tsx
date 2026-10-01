"use client";

import Link from "next/link";
import { Button } from "@tesserix/web";
import { consolePath } from "@tesserix/console-core";

/**
 * The CRM's own doors onto Import and Do-not-contact.
 *
 * ══ WHY, GIVEN BOTH ARE ALREADY IN THE SIDEBAR ══
 *
 * They are — `platform.crmImport` and `platform.crmSuppressions` have been in
 * the Growth group since #212, under the same `crm` capability as the queue
 * itself, so this is not a missing route or a gate. It is that the page an
 * operator is standing on when they want to import offers no way to get
 * there: `page.tsx` rendered a header with no `actions` and a tab bar whose
 * four entries are all views of the same queue.
 *
 * That gap is cheap to misread as the feature not existing, and it was —
 * which is the specific failure this closes. A built, tested, routed import
 * flow is not much use if the person who needs it concludes it was never
 * built.
 *
 * ══ A CLIENT COMPONENT, FOR THE REASON `CatalogLink` IS ONE ══
 *
 * `page.tsx` is a server component and `@tesserix/web`'s `Button` is a value
 * export off a `"use client"` barrel; importing it there resolves to
 * `undefined` at render — the trap `page-header.tsx` documents at its own
 * import, which neither typecheck nor build catches.
 *
 * ══ `consolePath`, NOT A LITERAL ══
 *
 * Both ids are in the route registry with their capability declared. A
 * hardcoded `/platform/crm/import` here would be a second place the path
 * lives, free to drift from the one `visibleNav` gates on.
 */
export function CrmToolLinks() {
  return (
    <>
      <Button asChild size="sm" variant="outline">
        <Link href={consolePath("platform.crmSuppressions")}>Do-not-contact</Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={consolePath("platform.crmImport")}>Import leads</Link>
      </Button>
    </>
  );
}
